import { Global, Injectable, Logger, Module } from '@nestjs/common';
import { Bot, Flow, FlowStep } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { LlmService } from '../llm.service';
import { findRule, noiseReason, relevantProducts, render, isGreeting } from './bot.logic';

export type BotWithFlows = Bot & { flows: Array<Flow & { steps: FlowStep[] }> };
export interface HistoryItem { direction: 'in' | 'out'; body: string }
export type OutMessage =
  | { type: 'text'; text: string }
  | { type: 'image' | 'document'; media: string; caption?: string; fileName?: string }
  | { type: 'delay'; seconds: number };
export interface Decision {
  messages: OutMessage[];
  /** 'ignored' = the bot deliberately stays silent (small talk, abuse, off-topic) */
  via: 'flow' | 'ai' | 'nomatch' | 'fallback' | 'ignored' | 'none';
  flowName?: string;
  handoff: boolean;
  reason?: string;
}

/**
 * Order: matching flow → AI (business info + products) → "No match" flow → fallback text.
 * Flows are checked against the latest message first, then everything unanswered.
 */
@Injectable()
export class BotEngine {
  private readonly log = new Logger('Bot');
  constructor(private prisma: PrismaService, private llm: LlmService) {}

  flowMessages(flow: Flow & { steps: FlowStep[] }, vars: { name?: string | null; number: string }): OutMessage[] {
    return [...flow.steps]
      .sort((a, b) => a.position - b.position)
      .map((s): OutMessage | null => {
        if (s.type === 'text') return s.text.trim() ? { type: 'text', text: render(s.text, vars) } : null;
        if (s.type === 'delay') return s.delaySeconds > 0 ? { type: 'delay', seconds: Math.min(30, s.delaySeconds) } : null;
        if ((s.type === 'image' || s.type === 'document') && s.media) {
          return { type: s.type, media: s.media, caption: s.text ? render(s.text, vars) : undefined, fileName: s.fileName || undefined };
        }
        return null;
      })
      .filter((m): m is OutMessage => !!m);
  }

  async decide(bot: BotWithFlows, latest: string, unanswered: string, history: HistoryItem[], contact: { name?: string | null; waId: string }): Promise<Decision> {
    const vars = { name: contact.name, number: contact.waId };
    const triggers = bot.flows.filter((f) => !f.isNoMatch && f.enabled && f.keywords.trim());
    // The newest message decides. Older unanswered messages are only looked at when the newest one
    // says nothing by itself ("ok", "?", an emoji). An earlier "hello" must never hide a real question
    // like "where is your shop?" behind the greeting flow.
    const older = unanswered.split('\n').reverse().filter((t) => t.trim() && t !== latest && !isGreeting(t));
    const candidates = noiseReason(latest) ? [latest, ...older] : [latest];
    let flow: (typeof triggers)[number] | undefined;
    for (const text of candidates) if ((flow = findRule(triggers, text))) break;
    if (flow) return { messages: this.flowMessages(flow, vars), via: 'flow', flowName: flow.name, handoff: false };

    // A plain greeting always gets a friendly reply: the welcome message, or a short default.
    // (Not left to the AI, which may treat "hi" as off-topic or be busy.)
    if (isGreeting(latest)) {
      const text = (bot.welcomeMessage || '').trim()
        ? render(bot.welcomeMessage, vars)
        : `Hello${contact.name ? ` ${contact.name.split(' ')[0]}` : ''}! 👋 How can I help you today?`;
      return { messages: [{ type: 'text', text }], via: 'flow', flowName: 'Greeting', handoff: false, reason: 'Greeting' };
    }

    // Nothing to answer: "ok", "thanks", emojis, single letters, abuse.
    const noise = noiseReason(latest);
    if (noise) {
      const reasons = { empty: 'Too short or emoji only', acknowledgement: 'Just an acknowledgement', abusive: 'Abusive message' } as const;
      return { messages: [], via: 'ignored', handoff: false, reason: reasons[noise] };
    }

    if (bot.aiEnabled && this.llm.enabled) {
      try {
        const ai = await this.askAi(bot, unanswered, history, contact);
        if (ai.via === 'ignored' || ai.messages.length) return ai;
      } catch (e) {
        this.log.warn(`AI failed: ${(e as Error).message}`);
      }
    }

    const noMatch = bot.flows.find((f) => f.isNoMatch && f.enabled);
    if (noMatch) {
      const messages = this.flowMessages(noMatch, vars);
      if (messages.length) return { messages, via: 'nomatch', flowName: noMatch.name, handoff: false, reason: 'No flow matched' };
    }
    const fallback = render(bot.fallbackMessage, vars).trim();
    return {
      messages: fallback ? [{ type: 'text', text: fallback }] : [],
      via: fallback ? 'fallback' : 'none',
      handoff: true,
      reason: 'No flow matched' + (bot.aiEnabled && !this.llm.enabled ? ' and AI is not configured' : ''),
    };
  }

  private businessInfo(bot: Bot) {
    const rows: Array<[string, string]> = [
      ['Company', bot.companyName], ['Location', bot.location], ['Industry', bot.industry], ['Primary goal', bot.primaryGoal],
      ['Support email', bot.supportEmail], ['Website', bot.websiteUrl], ['Phone numbers', (bot.phoneNumbers || '').replace(/\s*\n\s*/g, ', ')],
    ];
    return rows.filter(([, v]) => (v || '').trim()).map(([k, v]) => `${k}: ${(v || '').trim()}`).join('\n');
  }

  private async askAi(bot: BotWithFlows, text: string, history: HistoryItem[], contact: { name?: string | null; waId: string }): Promise<Decision> {
    let catalogue = '';
    if (bot.useProducts) {
      const products = await this.prisma.product.findMany({ where: { workspaceId: bot.workspaceId }, include: { category: true }, orderBy: { name: 'asc' }, take: 2000 });
      const picked = relevantProducts(products.map((p) => ({ ...p, categoryName: p.category?.name })), `${text} ${history.slice(-4).map((h) => h.body).join(' ')}`);
      catalogue = picked
        .map((p) => `- ${p.name}${p.sku ? ` (SKU ${p.sku})` : ''}${p.categoryName ? ` [${p.categoryName}]` : ''}: ${p.price != null ? `${p.currency} ${p.price}` : 'price on request'}, ${p.inStock ? 'in stock' : 'OUT OF STOCK'}${p.description ? `. ${p.description}` : ''}${p.imageUrl ? ` Link: ${p.imageUrl}` : ''}`)
        .join('\n');
    }
    const flowsHint = bot.flows
      .filter((f) => !f.isNoMatch && f.enabled && f.keywords.trim())
      .map((f) => `- "${f.name}": customers can type ${f.keywords.split(',').map((k) => `"${k.trim()}"`).slice(0, 3).join(' or ')}`)
      .join('\n');
    const transcript = history.slice(-16).map((h) => `${h.direction === 'in' ? 'Customer' : 'Business'}: ${h.body}`).join('\n');
    const info = this.businessInfo(bot);

    const out = await this.llm.json<{ relevant?: boolean; reply: string; handoff: boolean; reason?: string }>(
      `You are ${bot.assistantName || 'the WhatsApp assistant'}${bot.companyName ? ` for ${bot.companyName}` : ''}, answering customers on WhatsApp.\n` +
        'Rules:\n' +
        "- Reply in the customer's language and script (English, Hindi, Hinglish, …).\n" +
        '- Short and friendly: 1–4 sentences, plain text, at most a few emojis.\n' +
        '- Use ONLY facts from the business information, training data and products below. Never invent prices, stock, offers, timings, fees or policies.\n' +
        '- If a customer wants something one of the menu options below provides, tell them exactly what to type.\n' +
        '- Answer ONLY real questions or requests about this business, its services or products (or a simple greeting).\n' +
        '  For anything else — random words, chit-chat, jokes, "ok/thanks", forwards, personal or off-topic questions, rude or abusive messages — ' +
        'set relevant=false and reply="". Staying silent is better than a useless reply.\n' +
        '- If the answer is not available, the customer is upset, wants a human, or it is about refunds, payments or complaints: ' +
        `set handoff=true and reply with something close to: "${bot.fallbackMessage}"\n` +
        '- Never ask for passwords, OTPs or card numbers.\n' +
        (bot.instructions ? `\nInstructions:\n${bot.instructions}\n` : '') +
        (info ? `\nBusiness information:\n${info}\n` : '') +
        (bot.knowledge ? `\nTraining data:\n${bot.knowledge}\n` : '') +
        (flowsHint ? `\nMenu options customers can type:\n${flowsHint}\n` : '') +
        (catalogue ? `\nProducts:\n${catalogue}\n` : ''),
      `Customer name: ${contact.name || 'unknown'}\nConversation so far (oldest first):\n${transcript || '(none)'}\n\nCustomer's latest message(s): ${text}\n\n` +
        'Return {"relevant": boolean, "reply": string, "handoff": boolean, "reason": string}',
    );
    if (out.relevant === false) return { messages: [], via: 'ignored', handoff: false, reason: out.reason || 'Not about the business' };
    const reply = String(out.reply || '').slice(0, 1500).trim();
    return { messages: reply ? [{ type: 'text', text: reply }] : [], via: 'ai', handoff: !!out.handoff, reason: out.reason };
  }
}

@Global()
@Module({ providers: [BotEngine], exports: [BotEngine] })
export class BotModule {}
