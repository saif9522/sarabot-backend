import { Controller, Get } from '@nestjs/common';
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
    return { status, history, numbersUsed, agentsUsed };
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
