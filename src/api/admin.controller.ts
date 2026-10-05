import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { PrismaService } from '../prisma.service';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ACT_AS_COOKIE, hashPassword } from '../auth/crypto';
import { cookieOpts } from '../auth/auth.controller';
import { SubscriptionService } from '../billing/subscription.service';
import { SessionManager } from '../whatsapp/session.manager';

class PlanDto {
  @IsString() @MinLength(1) @MaxLength(80) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
  /** null = unlimited */
  @ValidateIf((o) => o.chatLimit !== null) @IsInt() @Min(1) chatLimit!: number | null;
  @IsInt() @Min(1) @Max(3660) durationDays!: number;
  @IsNumber() @Min(0) price!: number;
  @IsOptional() @IsString() @MaxLength(8) currency?: string;
  @IsInt() @Min(1) @Max(100) numbersLimit!: number;
  @IsInt() @Min(0) @Max(500) agentsLimit!: number;
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsBoolean() trialForSignup?: boolean;
  @IsOptional() @IsInt() sortOrder?: number;
}
class CustomerDto {
  @IsString() @MinLength(1) @MaxLength(120) businessName!: string;
  @IsString() @MinLength(1) @MaxLength(120) ownerName!: string;
  @IsEmail() ownerEmail!: string;
  @IsOptional() @IsString() @MaxLength(20) ownerMobile?: string;
  @IsString() @MinLength(8) @MaxLength(200) password!: string;
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}
class WorkspacePatchDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsIn(['active', 'suspended']) status?: 'active' | 'suspended';
  @IsOptional() @IsString() @MaxLength(2000) notes?: string;
}
class AddOwnerDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsEmail() email!: string;
  @IsString() @MinLength(8) @MaxLength(200) password!: string;
}
class ActivateDto {
  @IsString() planId!: string;
  /** "now" starts today; "after" queues it after the current plan ends */
  @IsIn(['now', 'after']) start!: 'now' | 'after';
  @IsOptional() @IsInt() @Min(1) @Max(3660) durationDays?: number;
  @IsOptional() @IsNumber() @Min(0) amountPaid?: number;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}
class ResetPasswordDto { @IsString() @MinLength(8) @MaxLength(200) password!: string }

/** Super Admin: customers, plans and subscriptions. */
@Roles('superadmin')
@Controller('admin')
export class AdminController {
  constructor(private prisma: PrismaService, private subs: SubscriptionService, private sessions: SessionManager) {}

  @Get('overview')
  async overview() {
    const now = new Date();
    const soon = new Date(Date.now() + 7 * 86400_000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const [customers, suspended, activeSubs, expiring, revenue, plans] = await Promise.all([
      this.prisma.workspace.count(),
      this.prisma.workspace.count({ where: { status: 'suspended' } }),
      this.prisma.subscription.findMany({ where: { status: 'active', startsAt: { lte: now }, endsAt: { gt: now } }, select: { workspaceId: true } }),
      this.prisma.subscription.findMany({
        where: { status: 'active', startsAt: { lte: now }, endsAt: { gt: now, lte: soon } },
        include: { workspace: { select: { id: true, name: true } } }, orderBy: { endsAt: 'asc' },
      }),
      this.prisma.subscription.groupBy({ by: ['currency'], where: { createdAt: { gte: monthStart }, status: { not: 'cancelled' } }, _sum: { amountPaid: true } }),
      this.prisma.plan.count({ where: { active: true } }),
    ]);
    const paying = new Set(activeSubs.map((s) => s.workspaceId)).size;
    return {
      customers, suspended, paying, withoutPlan: customers - paying, activePlans: plans,
      revenueThisMonth: revenue.map((r) => ({ currency: r.currency, amount: r._sum.amountPaid ?? 0 })),
      expiringSoon: expiring.map((s) => ({ workspaceId: s.workspace.id, name: s.workspace.name, planName: s.planName, endsAt: s.endsAt })),
    };
  }

  // ---------- Plans
  @Get('plans')
  plans() {
    return this.prisma.plan.findMany({ orderBy: [{ sortOrder: 'asc' }, { durationDays: 'asc' }, { price: 'asc' }], include: { _count: { select: { subscriptions: true } } } });
  }
  @Post('plans')
  async addPlan(@Body() dto: PlanDto) {
    if (dto.trialForSignup) await this.prisma.plan.updateMany({ data: { trialForSignup: false } });
    return this.prisma.plan.create({ data: { ...dto, name: dto.name.trim() } });
  }
  @Patch('plans/:id')
  async updatePlan(@Param('id') id: string, @Body() dto: PlanDto) {
    // Only one trial plan; existing subscriptions keep the limits they were sold with.
    if (dto.trialForSignup) await this.prisma.plan.updateMany({ where: { id: { not: id } }, data: { trialForSignup: false } });
    return this.prisma.plan.update({ where: { id }, data: { ...dto, name: dto.name.trim() } });
  }
  @Delete('plans/:id')
  async deletePlan(@Param('id') id: string) {
    const used = await this.prisma.subscription.count({ where: { planId: id } });
    if (used) return this.prisma.plan.update({ where: { id }, data: { active: false } }); // keep history; just hide it
    return this.prisma.plan.delete({ where: { id } });
  }

  // ---------- Customers (workspaces)
  @Get('customers')
  async customers() {
    const rows = await this.prisma.workspace.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        users: { where: { role: 'owner' }, select: { id: true, name: true, email: true, mobile: true, lastLoginAt: true } },
        _count: { select: { accounts: true, users: true } },
      },
    });
    return Promise.all(rows.map(async (w) => ({ ...w, plan: await this.subs.status(w.id) })));
  }

  @Post('customers')
  async addCustomer(@Body() dto: CustomerDto) {
    const email = dto.ownerEmail.trim().toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('A user with this email already exists');
    const passwordHash = await hashPassword(dto.password);
    return this.prisma.workspace.create({
      data: {
        name: dto.businessName.trim(), notes: dto.notes ?? '',
        users: { create: { email, name: dto.ownerName.trim(), mobile: dto.ownerMobile ?? '', role: 'owner', passwordHash } },
      },
    });
  }

  @Get('customers/:id')
  async customer(@Param('id') id: string) {
    const w = await this.prisma.workspace.findUnique({
      where: { id },
      include: {
        users: { select: { id: true, name: true, email: true, mobile: true, role: true, active: true, lastLoginAt: true, createdAt: true }, orderBy: { createdAt: 'asc' } },
        subscriptions: { orderBy: { startsAt: 'desc' } },
        accounts: { select: { id: true, label: true, phone: true } },
        _count: { select: { bots: true, products: true } },
      },
    });
    if (!w) throw new NotFoundException();
    return {
      ...w,
      accounts: w.accounts.map((a) => ({ ...a, status: this.sessions.state(a.id).status })),
      plan: await this.subs.status(id),
    };
  }

  @Patch('customers/:id')
  updateCustomer(@Param('id') id: string, @Body() dto: WorkspacePatchDto) {
    return this.prisma.workspace.update({ where: { id }, data: dto });
  }

  @Post('customers/:id/owner')
  async addOwner(@Param('id') id: string, @Body() dto: AddOwnerDto) {
    const email = dto.email.trim().toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('A user with this email already exists');
    return this.prisma.user.create({
      data: { workspaceId: id, email, name: dto.name.trim(), role: 'owner', passwordHash: await hashPassword(dto.password) },
      select: { id: true, email: true, name: true, role: true },
    });
  }

  @Post('users/:userId/password')
  @HttpCode(200)
  async resetPassword(@Param('userId') userId: string, @Body() dto: ResetPasswordDto) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u || u.role === 'superadmin') throw new NotFoundException();
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await hashPassword(dto.password), sessionVersion: { increment: 1 } } });
    return { ok: true };
  }

  @Delete('customers/:id')
  async deleteCustomer(@Param('id') id: string) {
    const accounts = await this.prisma.account.findMany({ where: { workspaceId: id }, select: { id: true } });
    for (const a of accounts) {
      await this.sessions.logout(a.id);
      this.sessions.forget(a.id);
    }
    await this.prisma.workspace.delete({ where: { id } });
    return { deleted: id };
  }

  // ---------- Subscriptions
  @Post('customers/:id/subscriptions')
  async activate(@Param('id') workspaceId: string, @Body() dto: ActivateDto, @CurrentUser() me: AuthUser) {
    const plan = await this.prisma.plan.findUnique({ where: { id: dto.planId } });
    if (!plan) throw new BadRequestException('Plan not found');
    const now = new Date();
    let startsAt = now;
    if (dto.start === 'after') {
      const last = await this.prisma.subscription.findFirst({ where: { workspaceId, status: 'active', endsAt: { gt: now } }, orderBy: { endsAt: 'desc' } });
      if (last) startsAt = last.endsAt;
    } else {
      // Starting now replaces whatever is running today.
      await this.prisma.subscription.updateMany({ where: { workspaceId, status: 'active', startsAt: { lte: now }, endsAt: { gt: now } }, data: { endsAt: now } });
    }
    const days = dto.durationDays ?? plan.durationDays;
    const endsAt = new Date(startsAt.getTime() + days * 86400_000);
    return this.prisma.subscription.create({
      data: {
        workspaceId, planId: plan.id, planName: plan.name, chatLimit: plan.chatLimit, numbersLimit: plan.numbersLimit, agentsLimit: plan.agentsLimit,
        startsAt, endsAt, amountPaid: dto.amountPaid ?? plan.price, currency: plan.currency, note: dto.note ?? '', activatedBy: me.email,
      },
    });
  }

  @Post('subscriptions/:subId/cancel')
  @HttpCode(200)
  cancel(@Param('subId') subId: string) {
    return this.prisma.subscription.update({ where: { id: subId }, data: { status: 'cancelled' } });
  }

  @Post('subscriptions/:subId/add-chats')
  @HttpCode(200)
  async addChats(@Param('subId') subId: string, @Body() body: { chats: number }) {
    const n = Math.floor(Number(body?.chats));
    if (!Number.isFinite(n) || n < 1 || n > 10_000_000) throw new BadRequestException('Enter a number of chats to add');
    const s = await this.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    if (s.chatLimit == null) throw new BadRequestException('This plan is already unlimited');
    return this.prisma.subscription.update({ where: { id: subId }, data: { chatLimit: s.chatLimit + n } });
  }

  @Post('subscriptions/:subId/extend')
  @HttpCode(200)
  async extend(@Param('subId') subId: string, @Body() body: { days: number }) {
    const d = Math.floor(Number(body?.days));
    if (!Number.isFinite(d) || d < 1 || d > 3660) throw new BadRequestException('Enter the number of days to add');
    const s = await this.prisma.subscription.findUniqueOrThrow({ where: { id: subId } });
    return this.prisma.subscription.update({ where: { id: subId }, data: { endsAt: new Date(s.endsAt.getTime() + d * 86400_000) } });
  }

  // ---------- Open a customer's workspace (to set up bots or help them)
  @Post('act-as/:id')
  @HttpCode(200)
  async actAs(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    if (!(await this.prisma.workspace.findUnique({ where: { id } }))) throw new NotFoundException();
    res.cookie(ACT_AS_COOKIE, id, { ...cookieOpts, maxAge: 12 * 3600_000 });
    return { ok: true };
  }

  @Post('act-as-exit')
  @HttpCode(200)
  exit(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(ACT_AS_COOKIE, cookieOpts);
    return { ok: true };
  }
}
