import { BadRequestException, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuthUser, CurrentUser, Public, Roles, ws } from '../auth/auth.guard';
import { SubscriptionService } from '../billing/subscription.service';

@Controller()
export class BillingController {
  constructor(private prisma: PrismaService, private subs: SubscriptionService) {}

  /** Current plan, usage and history for the signed-in customer. */
  @Roles('owner', 'admin')
  @Get('billing')
  async billing(@CurrentUser() u: AuthUser) {
    const [status, history, numbersUsed, agentsUsed] = await Promise.all([
      this.subs.status(ws(u)),
      this.prisma.subscription.findMany({ where: { workspaceId: ws(u) }, orderBy: { startsAt: 'desc' }, take: 50,
        select: { id: true, planName: true, chatLimit: true, chatsUsed: true, startsAt: true, endsAt: true, status: true, amountPaid: true, currency: true } }),
      this.prisma.account.count({ where: { workspaceId: ws(u) } }),
      this.prisma.user.count({ where: { workspaceId: ws(u), role: { in: ['admin', 'agent'] } } }),
    ]);
    return { status, history, numbersUsed, agentsUsed, trial: await this.trialFor(ws(u)) };
  }

  /** The free-trial plan, and whether this customer can still start it (once per customer, only without a running plan). */
  private async trialFor(workspaceId: string) {
    const plan = await this.prisma.plan.findFirst({ where: { active: true, trialForSignup: true } })
      ?? await this.prisma.plan.findFirst({ where: { active: true, price: 0 }, orderBy: { sortOrder: 'asc' } });
    if (!plan) return null;
    const [used, running] = await Promise.all([
      this.prisma.subscription.count({ where: { workspaceId, OR: [{ planId: plan.id }, { amountPaid: 0, activatedBy: { in: ['sign-up', 'free trial (self)'] } }] } }),
      this.subs.current(workspaceId),
    ]);
    return { planId: plan.id, planName: plan.name, durationDays: plan.durationDays, chatLimit: plan.chatLimit, available: used === 0 && !running, alreadyUsed: used > 0 };
  }

  /** Customer starts their free trial themselves. */
  @Roles('owner', 'admin')
  @Post('billing/trial')
  @HttpCode(200)
  async startTrial(@CurrentUser() u: AuthUser) {
    const t = await this.trialFor(ws(u));
    if (!t) throw new BadRequestException('There is no free trial right now.');
    if (t.alreadyUsed) throw new BadRequestException('You have already used your free trial. Choose a plan to continue.');
    if (!t.available) throw new BadRequestException('You already have an active plan.');
    const plan = await this.prisma.plan.findUniqueOrThrow({ where: { id: t.planId } });
    const sub = await this.subs.activate(ws(u), plan, { start: 'now', amountPaid: 0, note: 'Free trial started by customer', activatedBy: 'free trial (self)' });
    return { ok: true, planName: sub.planName, endsAt: sub.endsAt };
  }

  /** Plans shown on the public pricing page. */
  @Public()
  @Get('plans')
  plans() {
    return this.prisma.plan.findMany({
      where: { active: true },
      orderBy: [{ sortOrder: 'asc' }, { durationDays: 'asc' }, { price: 'asc' }],
      select: { id: true, name: true, description: true, chatLimit: true, durationDays: true, price: true, currency: true, numbersLimit: true, agentsLimit: true, trialForSignup: true },
    });
  }
}
