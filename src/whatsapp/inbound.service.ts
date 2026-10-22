import { Global, Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { RealtimeGateway } from '../realtime.gateway';
import { BotEngine, OutMessage } from '../bot/bot.engine';
import { isWorkingHours, optCommand, render } from '../bot/bot.logic';
import { pickText, replyLanguage, say } from '../bot/language';
import { Inbound, SessionManager } from './session.manager';
import { SubscriptionService } from '../billing/subscription.service';

const DEBOUNCE_MS = Math.max(0, Number(process.env.REPLY_DEBOUNCE_SECONDS ?? 1.5)) * 1000;
const MAX_PER_HOUR = Number(process.env.MAX_BOT_REPLIES_PER_HOUR ?? 30);
/** After a fallback / no-match reply, stay silent with that person for this long. */
const FALLBACK_COOLDOWN_MS = Math.max(0, Number(process.env.FALLBACK_COOLDOWN_MINUTES ?? 60)) * 60_000;

/**
 * Incoming message → save → wait a moment for follow-up messages → choose the bot for the
 * current hours → reply. A human can take over any chat by pausing the bot for that contact.
 */
@Injectable()
export class InboundService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Inbound');
  private timers = new Map<string, NodeJS.Timeout>();
  private busy = new Set<string>();
  /** Contacts that wrote again while their reply was being prepared: answer them once the current reply is out. */
  private again = new Set<string>();
  /** contactId -> time of the newest customer message the bot has already replied to (survives only until restart). */
  private handledUpTo = new Map<string, number>();
  /** contactId -> true when "typing…" was already shown long enough while thinking */
  private quickReply = new Map<string, boolean>();

  constructor(private prisma: PrismaService, private sessions: SessionManager, private engine: BotEngine, private rt: RealtimeGateway, private subs: SubscriptionService) {}


  /** contactId -> id of the newest customer message the bot has already looked at (replied or decided to stay silent) */
  private attempted = new Map<string, string>();
  private sweeper?: NodeJS.Timeout;

  onModuleInit() {
    this.sessions.onMessage((m) => this.receive(m));
    // Safety net: every 30 s, answer any customer message that is still waiting (e.g. the server restarted
    // during the short wait before replying, or a reply failed). Each message is only retried once.
    this.sweeper = setInterval(() => this.sweep().catch((e) => this.log.warn(`Sweep failed: ${e.message}`)), 30_000);
  }

  onModuleDestroy() {
    clearInterval(this.sweeper);
  }

  private async sweep() {
    const now = Date.now();
    const recent = await this.prisma.contact.findMany({
      where: {
        lastMessageAt: { gte: new Date(now - 15 * 60_000), lte: new Date(now - 20_000) },
        botPaused: false, optedOut: false, account: { botEnabled: true },
      },
      select: { id: true, messages: { orderBy: { createdAt: 'desc' }, take: 1, select: { id: true, direction: true } } },
      take: 200,
    });
    for (const c of recent) {
      const last = c.messages[0];
      if (!last || last.direction !== 'in' || this.attempted.get(c.id) === last.id) continue;
      if (this.busy.has(c.id) || this.timers.has(c.id)) continue;
      this.log.log(`Safety net: answering a waiting message from contact ${c.id}`);
      await this.respond(c.id).catch((e) => this.log.error(`Reply failed: ${e.message}`));
    }
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
    if (this.busy.has(contactId)) {
      // Before, this message was silently dropped (AI + typing can take 10–20 s). Now it is answered right after.
      this.again.add(contactId);
      return;
    }
    this.busy.add(contactId);
    try {
      const contact = await this.prisma.contact.findUniqueOrThrow({
        where: { id: contactId },
        include: { account: { include: { workingBot: { include: { flows: { include: { steps: true } } } }, offHoursBot: { include: { flows: { include: { steps: true } } } } } } },
      });
      const history = await this.prisma.message.findMany({ where: { contactId }, orderBy: { createdAt: 'desc' }, take: 30 });
      history.reverse();
      const lastIn = [...history].reverse().find((h) => h.direction === 'in');
      if (lastIn) this.attempted.set(contactId, lastIn.id); // the safety net won't try this message again
      const lastOut = [...history].reverse().find((h) => h.direction === 'out');
      // Which customer messages still need an answer. A message that arrived while the previous reply was
      // being typed is older than that reply, so "newer than the last outgoing message" is not enough.
      const mark = this.handledUpTo.get(contactId);
      const lastHuman = [...history].reverse().find((h) => h.direction === 'out' && h.sentBy === 'human');
      const cutoff = mark !== undefined ? Math.max(mark, lastHuman?.createdAt.getTime() ?? 0) : (lastOut?.createdAt.getTime() ?? 0);
      if (!lastIn || lastIn.createdAt.getTime() <= cutoff) return; // already answered
      const { account } = contact;
      const vars = { name: contact.name, number: contact.waId };

      // STOP / START are always honoured, even when the bot is off.
      const cmd = optCommand(lastIn.body);
      if (cmd) {
        await this.prisma.contact.update({ where: { id: contactId }, data: { optedOut: cmd === 'stop' } });
        const earlier = history.filter((h) => h.direction === 'in' && h.id !== lastIn.id).map((h) => h.body);
        const lang = replyLanguage(account.workingBot?.language ?? 'auto', lastIn.body, earlier);
        await this.send(account.id, contact.id, contact.waId, say(cmd, lang), 'system');
        this.handledUpTo.set(contactId, lastIn.createdAt.getTime());
        return;
      }
      // Every silent exit says why in the log ("No reply to +91…: …"), so a missing reply is easy to explain.
      const silent = (why: string) => this.log.log(`No reply to +${contact.waId}: ${why}`);
      if (contact.optedOut) return silent('customer sent STOP (unsubscribed) — they can send START');
      if (!account.botEnabled) return silent('bot is switched off for this number (Numbers page)');
      if (contact.botPaused) return silent('bot is paused for this chat because a person replied from the dashboard — turn "Bot" back on in Chats');
      const wsId = account.workspaceId;
      if (!wsId) return silent('number has no workspace');

      const working = isWorkingHours(account);
      const bot = working ? account.workingBot : account.offHoursBot;
      if (!bot) return silent(`no ${working ? 'working-hours' : 'after-hours'} bot chosen for this number (Numbers page)`);

      const since = new Date(Date.now() - 3600_000);
      const recent = await this.prisma.message.count({ where: { contactId, direction: 'out', sentBy: { not: 'human' }, createdAt: { gte: since } } });
      if (recent >= MAX_PER_HOUR) {
        this.log.warn(`No reply to +${contact.waId}: hourly limit of ${MAX_PER_HOUR} bot replies reached (MAX_BOT_REPLIES_PER_HOUR); waiting for a human`);
        await this.flagHuman(contact.id, account.id);
        return;
      }

      // Answer everything the customer sent since our last reply.
      const unanswered = history.filter((h) => h.direction === 'in' && h.createdAt.getTime() > cutoff).map((h) => h.body);
      // Show "typing…" right away while the reply is worked out (AI can take a few seconds).
      const thinkingSince = Date.now();
      this.sessions.presence(account.id, contact.waId, 'composing');
      let decision;
      try {
        decision = await this.engine.decide(bot, lastIn.body, unanswered.join('\n'), history.map((h) => ({ direction: h.direction as 'in' | 'out', body: h.body })), contact);
      } catch (e) {
        this.sessions.presence(account.id, contact.waId, 'paused');
        throw e;
      }
      // The customer has already watched "typing…" while we were thinking: don't make them wait again.
      this.quickReply.set(contactId, Date.now() - thinkingSince > 1200);
      if (!decision.messages.length) this.sessions.presence(account.id, contact.waId, 'paused');

      // Welcome in the customer's language (Hindi version for Hindi / Hinglish customers, if the owner wrote one).
      const isFirstConversation = !history.some((h) => h.direction === 'out');
      const welcomeText = pickText(bot.welcomeMessage, bot.welcomeMessageHi, decision.lang ?? 'en');
      const welcome = isFirstConversation && welcomeText ? render(welcomeText, vars) : null;

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
          silent(`${decision.reason || 'no answer'} — fallback message was already sent in the last ${Math.round(FALLBACK_COOLDOWN_MS / 60000)} min (FALLBACK_COOLDOWN_MINUTES)`);
          await this.flagHuman(contact.id, account.id);
          return;
        }
        // First message with a welcome configured: the welcome is enough; skip the fallback.
        if (welcome) decision.messages = [];
      }

      if (!decision.messages.length && !welcome) {
        silent(decision.reason || 'nothing to send');
        if (decision.handoff) await this.flagHuman(contact.id, account.id);
        return;
      }
      // One automatic reply = one chat from the customer's plan.
      if (!(await this.subs.consume(wsId))) {
        this.log.warn(`No reply to +${contact.waId}: no active plan, plan expired or all chats used up (workspace ${wsId}) — add chats or activate a plan`);
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
      } finally {
        if (sentAny) this.handledUpTo.set(contactId, lastIn.createdAt.getTime());
      }
      if (decision.handoff) await this.flagHuman(contact.id, account.id);
    } finally {
      this.quickReply.delete(contactId);
      this.busy.delete(contactId);
      if (this.again.delete(contactId)) {
        this.respond(contactId).catch((e) => this.log.error(`Reply failed: ${e.message}`));
      }
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
      ? await this.sessions.sendText(accountId, waId, msg.text, { typing: sentBy !== 'human' && !this.quickReply.get(contactId) }) // a person's reply goes out instantly
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
