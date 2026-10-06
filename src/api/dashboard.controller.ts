import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { SessionManager } from '../whatsapp/session.manager';
import { LlmService } from '../llm.service';
import { AuthUser, CurrentUser, ws } from '../auth/auth.guard';
import { SubscriptionService } from '../billing/subscription.service';

/** "2026-10-06" -> local midnight; invalid -> null */
function day(s?: string): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new BadRequestException('Dates must look like 2026-10-06');
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

@Controller('dashboard')
export class DashboardController {
  constructor(private prisma: PrismaService, private sessions: SessionManager, private llm: LlmService, private subs: SubscriptionService) {}

  /** Totals for a date range (default: today), overall and per linked number. */
  @Get()
  async summary(@CurrentUser() u: AuthUser, @Query('from') fromQ?: string, @Query('to') toQ?: string) {
    const w = ws(u);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const from = day(fromQ) ?? today;
    const toDay = day(toQ) ?? from;
    if (toDay < from) throw new BadRequestException('"to" is before "from"');
    const to = new Date(toDay.getFullYear(), toDay.getMonth(), toDay.getDate() + 1); // exclusive
    const range = { gte: from, lt: to };

    const [accounts, subscribers, newInRange, needsHuman, bots, products] = await Promise.all([
      this.prisma.account.findMany({ where: { workspaceId: w }, orderBy: { createdAt: 'asc' }, select: { id: true, label: true, phone: true, botEnabled: true } }),
      this.prisma.contact.count({ where: { account: { workspaceId: w } } }),
      this.prisma.contact.count({ where: { account: { workspaceId: w }, firstSeenAt: range } }),
      this.prisma.contact.count({ where: { account: { workspaceId: w }, needsHuman: true, ...(u.effectiveRole === 'agent' ? { OR: [{ assignedToId: u.id }, { assignedToId: null }] } : {}) } }),
      this.prisma.bot.count({ where: { workspaceId: w } }),
      this.prisma.product.count({ where: { workspaceId: w } }),
    ]);

    const perNumber = await Promise.all(
      accounts.map(async (a) => {
        const rows = await this.prisma.message.groupBy({ by: ['direction', 'sentBy'], where: { createdAt: range, contact: { accountId: a.id } }, _count: true });
        const n = (f: (r: (typeof rows)[number]) => boolean) => rows.filter(f).reduce((s, r) => s + r._count, 0);
        return {
          id: a.id, label: a.label, phone: a.phone, botEnabled: a.botEnabled,
          status: this.sessions.state(a.id).status,
          received: n((r) => r.direction === 'in'),
          botReplies: n((r) => r.direction === 'out' && r.sentBy !== 'human'),
          humanReplies: n((r) => r.sentBy === 'human'),
          byFlow: n((r) => r.sentBy === 'flow' || r.sentBy === 'nomatch'),
          byAi: n((r) => r.sentBy === 'ai'),
        };
      }),
    );
    const sum = (k: 'received' | 'botReplies' | 'humanReplies' | 'byFlow' | 'byAi') => perNumber.reduce((s, r) => s + r[k], 0);

    return {
      aiAvailable: this.llm.enabled,
      range: { from: from.toISOString(), to: toDay.toISOString() },
      numbers: { total: accounts.length, connected: accounts.filter((a) => this.sessions.isConnected(a.id)).length },
      subscribers: { total: subscribers, newInRange },
      needsHuman,
      totals: { received: sum('received'), botReplies: sum('botReplies'), humanReplies: sum('humanReplies'), byFlow: sum('byFlow'), byAi: sum('byAi') },
      perNumber,
      setup: { bots, products },
      plan: await this.subs.status(w),
    };
  }
}
