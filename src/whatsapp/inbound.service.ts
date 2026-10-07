import { Global, Injectable, Logger, Module, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { RealtimeGateway } from '../realtime.gateway';
import { BotEngine, OutMessage } from '../bot/bot.engine';
import { isWorkingHours, optCommand, render } from '../bot/bot.logic';
import { Inbound, SessionManager } from './session.manager';
import { SubscriptionService } from '../billing/subscription.service';

const DEBOUNCE_MS = Math.max(0, Number(process.env.REPLY_DEBOUNCE_SECONDS ?? 3)) * 1000;
const MAX_PER_HOUR = Number(process.env.MAX_BOT_REPLIES_PER_HOUR ?? 30);
/** After a fallback / no-match reply, stay silent with that person for this long. */
const FALLBACK_COOLDOWN_MS = Math.max(0, Number(process.env.FALLBACK_COOLDOWN_MINUTES ?? 60)) * 60_000;

/**
 * Incoming message → save → wait a moment for follow-up messages → choose the bot for the
 * current hours → reply. A human can take over any chat by pausing the bot for that contact.
 */
@Injectable()
export class InboundService implements OnModuleInit {
  private readonly log = new Logger('Inbound');
  private timers = new Map<string, NodeJS.Timeout>();
  private busy = new Set<string>();

  constructor(private prisma: PrismaService, private sessions: SessionManager, private engine: BotEngine, private rt: RealtimeGateway, private subs: SubscriptionService) {}

  private noPlanLogged = new Map<string, number>();

  onModuleInit() {
    this.sessions.onMessage((m) => this.receive(m));
  }

  async receive(m: Inbound) {
    if (await this.prisma.message.findUnique({ where: { externalId: m.id } })) return;
    const contact = await this.prisma.contact.upsert({
      where: { accountId_waId: { accountId: m.accountId, waId: m.from } },
      update: { lastMessageAt: new Date(), messageCount: { increment: 1 }, ...(m.name ? { name: m.name } : {}) },
      create: { accountId: m.accountId, waId: m.from, name: m.name, messageCount: 1 },
    });
    if (contact.messageCount === 1 && !contact.assignedToId && m.workspaceId) await this.autoAssign(m.workspaceId, contact.id);
    const msg = await this.prisma.message.create({ data: { contactId: contact.id, direction: 'in', body: m.text, sentBy: 'customer', externalId: m.id } });
    this.rt.toWorkspace(m.workspaceId, 'message', { contactId: contact.id, accountId: m.accountId, message: msg });
    this.sessions.markRead(m.accountId, m.from, m.id);

    clearTimeout(this.timers.get(contact.id));
    this.timers.set(contact.id, setTimeout(() => {
      this.timers.delete(contact.id);
      this.respond(contact.id).catch((e) => this.log.error(`Reply failed: ${e.message}`));
    }, DEBOUNCE_MS));
  }

  private async respond(contactId: string) {
    if (this.busy.has(contactId)) return;
    this.busy.add(contactId);
    try {
      const contact = await this.prisma.contact.findUniqueOrThrow({
        where: { id: contactId },
        include: { account: { include: { workingBot: { include: { flows: { include: { steps: true } } } }, offHoursBot: { include: { flows: { include: { steps: true } } } } } } },
      });
      const history = await this.prisma.message.findMany({ where: { contactId }, orderBy: { createdAt: 'desc' }, take: 30 });
      history.reverse();
      const lastIn = [...history].reverse().find((h) => h.direction === 'in');
      const lastOut = [...history].reverse().find((h) => h.direction === 'out');
      if (!lastIn || (lastOut && lastOut.createdAt > lastIn.createdAt)) return; // already answered
      const { account } = contact;
      const vars = { name: contact.name, number: contact.waId };

      // STOP / START are always honoured, even when the bot is off.
      const cmd = optCommand(lastIn.body);
      if (cmd) {
        await this.prisma.contact.update({ where: { id: contactId }, data: { optedOut: cmd === 'stop' } });
        await this.send(account.id, contact.id, contact.waId, cmd === 'stop'
          ? 'You have been unsubscribed and will not get automatic replies. Send START to subscribe again.'
          : 'Welcome back! You are subscribed again.', 'system');
        return;
      }
      if (contact.optedOut || !account.botEnabled || contact.botPaused) return;
      const wsId = account.workspaceId;
      if (!wsId) return;

      const bot = isWorkingHours(account) ? account.workingBot : account.offHoursBot;
      if (!bot) return;

      const since = new Date(Date.now() - 3600_000);
      const recent = await this.prisma.message.count({ where: { contactId, direction: 'out', sentBy: { not: 'human' }, createdAt: { gte: since } } });
      if (recent >= MAX_PER_HOUR) {
        this.log.warn(`Hourly limit reached for +${contact.waId}; waiting for a human`);
        await this.flagHuman(contact.id, account.id);
        return;
      }

      const isFirstConversation = !history.some((h) => h.direction === 'out');
      const welcome = isFirstConversation && bot.welcomeMessage.trim() ? render(bot.welcomeMessage, vars) : null;

      // Answer everything the customer sent since our last reply.
      const unanswered = history.filter((h) => h.direction === 'in' && (!lastOut || h.createdAt > lastOut.createdAt)).map((h) => h.body);
      const decision = await this.engine.decide(bot, lastIn.body, unanswered.join('\n'), history.map((h) => ({ direction: h.direction as 'in' | 'out', body: h.body })), contact);

      if (welcome && decision.flowName === 'Greeting') decision.messages = []; // the welcome below already greets

      if (decision.via === 'ignored') {
        this.log.log(`No reply to +${contact.waId}: ${decision.reason}`);
        return;
      }

      // Don't repeat the fallback / no-match message: once per cooldown, then wait for a human.
      if (decision.via === 'fallback' || decision.via === 'nomatch' || decision.via === 'none') {
        const lastBot = [...history].reverse().find((h) => h.direction === 'out' && h.sentBy !== 'human');
        const recentlySent = lastBot && ['fallback', 'nomatch'].includes(lastBot.sentBy) && Date.now() - lastBot.createdAt.getTime() < FALLBACK_COOLDOWN_MS;
        if (recentlySent) {
          await this.flagHuman(contact.id, account.id);
          return;
        }
        // First message with a welcome configured: the welcome is enough; skip the fallback.
        if (welcome) decision.messages = [];
      }

      if (!decision.messages.length && !welcome) {
        if (decision.handoff) await this.flagHuman(contact.id, account.id);
        return;
      }
      // One automatic reply = one chat from the customer's plan.
      if (!(await this.subs.consume(wsId))) {
        const last = this.noPlanLogged.get(wsId) ?? 0;
        if (Date.now() - last > 3600_000) {
          this.noPlanLogged.set(wsId, Date.now());
          this.log.warn(`Workspace ${wsId}: no active plan or chats used up — not replying automatically`);
        }
        await this.flagHuman(contact.id, account.id);
        return;
      }
      let sentAny = false;
      try {
        if (welcome) {
          await this.send(account.id, contact.id, contact.waId, welcome, 'welcome');
          sentAny = true;
        }
        const sentBy = decision.via === 'none' ? 'fallback' : decision.via;
        for (const m of decision.messages) {
          try {
            if (await this.send(account.id, contact.id, contact.waId, m, sentBy)) sentAny = true;
          } catch (e) {
            const msg = (e as Error).message || '';
            if (/not connected/i.test(msg)) throw e; // the number is down: nothing else will go out either
            this.log.warn(`Skipped one ${m.type} step for ${contact.waId}: ${msg}`);
            // An image/document that can't be sent: still deliver its caption so the customer gets the words.
            if ((m.type === 'image' || m.type === 'document') && m.caption?.trim()) {
              if (await this.send(account.id, contact.id, contact.waId, m.caption, sentBy).catch(() => null)) sentAny = true;
            }
          }
        }
      } catch (e) {
        if (!sentAny) await this.subs.refund(wsId); // nothing reached the customer: give the chat back
        throw e;
      }
      if (decision.handoff) await this.flagHuman(contact.id, account.id);
    } finally {
      this.busy.delete(contactId);
    }
  }

  private async flagHuman(contactId: string, accountId: string) {
    const c = await this.prisma.contact.update({ where: { id: contactId }, data: { needsHuman: true }, include: { account: { select: { workspaceId: true } } } });
    this.rt.toWorkspace(c.account.workspaceId, 'handoff', { contactId, accountId });
  }

  /** Round-robin: the active agent who was assigned a chat longest ago gets the new one. */
  private async autoAssign(workspaceId: string, contactId: string) {
    const w = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { autoAssign: true } });
    if (!w?.autoAssign) return;
    const pool = await this.prisma.user.findMany({ where: { workspaceId, active: true, role: 'agent' }, orderBy: [{ lastAssignedAt: { sort: 'asc', nulls: 'first' } }, { createdAt: 'asc' }], take: 1 });
    const next = pool[0];
    if (!next) return;
    await this.prisma.$transaction([
      this.prisma.contact.update({ where: { id: contactId }, data: { assignedToId: next.id } }),
      this.prisma.user.update({ where: { id: next.id }, data: { lastAssignedAt: new Date() } }),
    ]);
  }

  /** Send and record one outgoing message (text, image, document or a pause). */
  async send(accountId: string, contactId: string, waId: string, m: OutMessage | string, sentBy: string) {
    const msg: OutMessage = typeof m === 'string' ? { type: 'text', text: m } : m;
    if (msg.type === 'delay') {
      await new Promise((r) => setTimeout(r, msg.seconds * 1000));
      return null;
    }
    const externalId = msg.type === 'text'
      ? await this.sessions.sendText(accountId, waId, msg.text, { typing: sentBy !== 'human' }) // a person's reply goes out instantly
      : await this.sessions.sendMedia(accountId, waId, msg);
    const saved = await this.prisma.message.create({
      data: {
        contactId, direction: 'out', sentBy, externalId, type: msg.type,
        body: msg.type === 'text' ? msg.text : msg.caption || msg.fileName || '',
        media: msg.type === 'text' ? '' : msg.media,
      },
    });
    await this.prisma.contact.update({ where: { id: contactId }, data: { lastMessageAt: new Date(), ...(sentBy === 'human' ? { needsHuman: false } : {}) } });
    const owner = await this.prisma.account.findUnique({ where: { id: accountId }, select: { workspaceId: true } });
    this.rt.toWorkspace(owner?.workspaceId, 'message', { contactId, accountId, message: saved });
    return saved;
  }
}

@Global()
@Module({ providers: [InboundService], exports: [InboundService] })
export class InboundModule {}
