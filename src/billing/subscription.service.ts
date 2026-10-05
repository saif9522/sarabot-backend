import { Global, Injectable, Module } from '@nestjs/common';
import { Plan, Prisma, Subscription } from '@prisma/client';
import { PrismaService } from '../prisma.service';

export interface PlanStatus {
  active: boolean;
  /** Why the bot is not replying, when inactive */
  reason: 'none' | 'expired' | 'used_up' | 'suspended' | null;
  planName: string | null;
  chatLimit: number | null;
  chatsUsed: number;
  chatsLeft: number | null;
  numbersLimit: number;
  agentsLimit: number;
  startsAt: Date | null;
  endsAt: Date | null;
  daysLeft: number | null;
  /** A plan that starts later (queued after the current one) */
  upcoming: { planName: string; startsAt: Date; endsAt: Date } | null;
}

/** Limits when a workspace has no plan: setup is possible, automatic replies are not. */
const NO_PLAN = { numbersLimit: 1, agentsLimit: 1 };

@Injectable()
export class SubscriptionService {
  constructor(private prisma: PrismaService) {}

  /** The subscription in force right now (latest started, not cancelled, not ended). */
  async current(workspaceId: string, now = new Date()): Promise<Subscription | null> {
    return this.prisma.subscription.findFirst({
      where: { workspaceId, status: 'active', startsAt: { lte: now }, endsAt: { gt: now } },
      orderBy: { startsAt: 'desc' },
    });
  }

  async status(workspaceId: string): Promise<PlanStatus> {
    const now = new Date();
    const [ws, sub, upcoming, last] = await Promise.all([
      this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { status: true } }),
      this.current(workspaceId, now),
      this.prisma.subscription.findFirst({ where: { workspaceId, status: 'active', startsAt: { gt: now } }, orderBy: { startsAt: 'asc' } }),
      this.prisma.subscription.findFirst({ where: { workspaceId, status: 'active' }, orderBy: { endsAt: 'desc' } }),
    ]);
    const up = upcoming ? { planName: upcoming.planName, startsAt: upcoming.startsAt, endsAt: upcoming.endsAt } : null;
    if (!sub) {
      return {
        active: false, reason: ws?.status === 'suspended' ? 'suspended' : last ? 'expired' : 'none',
        planName: last?.planName ?? null, chatLimit: last?.chatLimit ?? null, chatsUsed: last?.chatsUsed ?? 0, chatsLeft: 0,
        ...NO_PLAN, startsAt: last?.startsAt ?? null, endsAt: last?.endsAt ?? null, daysLeft: null, upcoming: up,
      };
    }
    const chatsLeft = sub.chatLimit == null ? null : Math.max(0, sub.chatLimit - sub.chatsUsed);
    const usedUp = chatsLeft === 0;
    const suspended = ws?.status === 'suspended';
    return {
      active: !usedUp && !suspended,
      reason: suspended ? 'suspended' : usedUp ? 'used_up' : null,
      planName: sub.planName, chatLimit: sub.chatLimit, chatsUsed: sub.chatsUsed, chatsLeft,
      numbersLimit: sub.numbersLimit, agentsLimit: sub.agentsLimit,
      startsAt: sub.startsAt, endsAt: sub.endsAt,
      daysLeft: Math.max(0, Math.ceil((sub.endsAt.getTime() - now.getTime()) / 86400_000)),
      upcoming: up,
    };
  }

  /**
   * Reserve one automatic reply. Atomic: two replies at the same moment can't both take
   * the last chat. Returns false when there is no plan, it expired, or chats are used up.
   */
  async consume(workspaceId: string): Promise<boolean> {
    const ws = await this.prisma.workspace.findUnique({ where: { id: workspaceId }, select: { status: true } });
    if (ws?.status !== 'active') return false;
    const sub = await this.current(workspaceId);
    if (!sub) return false;
    if (sub.chatLimit == null) {
      await this.prisma.subscription.update({ where: { id: sub.id }, data: { chatsUsed: { increment: 1 } } });
      return true;
    }
    const r = await this.prisma.subscription.updateMany({ where: { id: sub.id, chatsUsed: { lt: sub.chatLimit } }, data: { chatsUsed: { increment: 1 } } });
    return r.count === 1;
  }

  /** Give back a reserved chat when sending failed. */
  async refund(workspaceId: string) {
    const sub = await this.current(workspaceId);
    if (sub && sub.chatsUsed > 0) await this.prisma.subscription.update({ where: { id: sub.id }, data: { chatsUsed: { decrement: 1 } } });
  }

  /**
   * Start a plan for a workspace.
   *  'now'   – starts today and ends whatever is running
   *  'after' – starts when the latest running/queued plan ends (renewal); today if none
   */
  async activate(
    workspaceId: string, plan: Plan,
    opts: { start: 'now' | 'after'; durationDays?: number; amountPaid?: number; note?: string; activatedBy: string },
    tx: Prisma.TransactionClient = this.prisma,
  ) {
    const now = new Date();
    let startsAt = now;
    if (opts.start === 'after') {
      const last = await tx.subscription.findFirst({ where: { workspaceId, status: 'active', endsAt: { gt: now } }, orderBy: { endsAt: 'desc' } });
      if (last) startsAt = last.endsAt;
    } else {
      await tx.subscription.updateMany({ where: { workspaceId, status: 'active', startsAt: { lte: now }, endsAt: { gt: now } }, data: { endsAt: now } });
    }
    const days = opts.durationDays ?? plan.durationDays;
    return tx.subscription.create({
      data: {
        workspaceId, planId: plan.id, planName: plan.name, chatLimit: plan.chatLimit, numbersLimit: plan.numbersLimit, agentsLimit: plan.agentsLimit,
        startsAt, endsAt: new Date(startsAt.getTime() + days * 86400_000), amountPaid: opts.amountPaid ?? plan.price, currency: plan.currency,
        note: opts.note ?? '', activatedBy: opts.activatedBy,
      },
    });
  }

  async limits(workspaceId: string) {
    const s = await this.status(workspaceId);
    return { numbersLimit: s.numbersLimit, agentsLimit: s.agentsLimit };
  }
}

@Global()
@Module({ providers: [SubscriptionService], exports: [SubscriptionService] })
export class SubscriptionModule {}
