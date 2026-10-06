import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, NotFoundException, Param, Patch, Post, Res } from '@nestjs/common';
import { Response } from 'express';
import { IsBoolean, IsEmail, IsIn, IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { PrismaService } from '../prisma.service';
import { AuthUser, CurrentUser, Roles } from '../auth/auth.guard';
import { ACT_AS_COOKIE, hashPassword } from '../auth/crypto';
import { cookieOpts } from '../auth/auth.controller';
import { SubscriptionService } from '../billing/subscription.service';
import { SessionManager } from '../whatsapp/session.manager';
import { SETTING_KEYS, SettingKey, SettingsService } from '../settings/settings.service';
import { Query } from '@nestjs/common';

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
class UserPatchDto {
  @IsOptional() @IsBoolean() active?: boolean;
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(20) mobile?: string;
  @IsOptional() @IsEmail() email?: string;
  @IsOptional() @IsIn(['owner', 'admin', 'agent']) role?: 'owner' | 'admin' | 'agent';
}

/** Super Admin: customers, plans and subscriptions. */
@Roles('superadmin')
@Controller('admin')
export class AdminController {
  constructor(private prisma: PrismaService, private subs: SubscriptionService, private sessions: SessionManager, private settings: SettingsService) {}

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
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const [users, numbers, subscribers, msgIn, botReplies, paymentsToday] = await Promise.all([
      this.prisma.user.groupBy({ by: ['role'], where: { role: { not: 'superadmin' } }, _count: true }),
      this.prisma.account.findMany({ select: { id: true } }),
      this.prisma.contact.count(),
      this.prisma.message.count({ where: { direction: 'in', createdAt: { gte: today } } }),
      this.prisma.message.count({ where: { direction: 'out', sentBy: { not: 'human' }, createdAt: { gte: today } } }),
      this.prisma.payment.count({ where: { status: 'paid', paidAt: { gte: today } } }),
    ]);
    const role = (r: string) => users.find((x) => x.role === r)?._count ?? 0;
    return {
      customers, suspended, paying, withoutPlan: customers - paying, activePlans: plans,
      people: { owners: role('owner'), admins: role('admin'), agents: role('agent') },
      numbers: { total: numbers.length, connected: numbers.filter((n) => this.sessions.isConnected(n.id)).length },
      subscribers, today: { received: msgIn, botReplies, payments: paymentsToday },
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
        users: {
          select: { id: true, name: true, email: true, mobile: true, role: true, active: true, seeUnassigned: true, lastLoginAt: true, createdAt: true, _count: { select: { assigned: true } } },
          orderBy: { createdAt: 'asc' },
        },
        subscriptions: { orderBy: { startsAt: 'desc' } },
        payments: { orderBy: { createdAt: 'desc' }, take: 50 },
        accounts: { select: { id: true, label: true, phone: true } },
        _count: { select: { bots: true, products: true } },
      },
    });
    if (!w) throw new NotFoundException();
    const [subscribers, messages, botReplies] = await Promise.all([
      this.prisma.contact.count({ where: { account: { workspaceId: id } } }),
      this.prisma.message.count({ where: { contact: { account: { workspaceId: id } } } }),
      this.prisma.message.count({ where: { direction: 'out', sentBy: { not: 'human' }, contact: { account: { workspaceId: id } } } }),
    ]);
    return {
      ...w,
      stats: { subscribers, messages, botReplies },
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

  // ---------- Everyone (owners, admins, agents) across all customers
  @Get('users')
  users(@Query('q') q?: string, @Query('role') role?: string, @Query('status') status?: string) {
    const term = q?.trim();
    return this.prisma.user.findMany({
      where: {
        role: role && ['owner', 'admin', 'agent'].includes(role) ? role : { not: 'superadmin' },
        ...(status === 'active' ? { active: true } : status === 'disabled' ? { active: false } : {}),
        ...(term ? { OR: [
          { name: { contains: term, mode: 'insensitive' } }, { email: { contains: term, mode: 'insensitive' } },
          { mobile: { contains: term } }, { workspace: { name: { contains: term, mode: 'insensitive' } } },
        ] } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
      select: {
        id: true, name: true, email: true, mobile: true, role: true, active: true, seeUnassigned: true, createdAt: true, lastLoginAt: true,
        workspace: { select: { id: true, name: true, status: true } }, _count: { select: { assigned: true } },
      },
    });
  }

  @Patch('users/:userId')
  async updateUser(@Param('userId') userId: string, @Body() dto: UserPatchDto) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u || u.role === 'superadmin') throw new NotFoundException();
    const email = dto.email?.trim().toLowerCase();
    if (email && email !== u.email && (await this.prisma.user.findUnique({ where: { email } }))) {
      throw new ConflictException('Another user already uses this email');
    }
    const data = {
      ...dto,
      ...(email ? { email } : {}),
      ...(dto.name ? { name: dto.name.trim() } : {}),
      ...(dto.mobile !== undefined ? { mobile: dto.mobile.trim() } : {}),
      ...(dto.active === false ? { sessionVersion: { increment: 1 } } : {}), // disabling signs them out
    };
    const updated = await this.prisma.user.update({ where: { id: userId }, data, select: { id: true, name: true, email: true, mobile: true, active: true, role: true } });
    if (dto.active === false) await this.prisma.contact.updateMany({ where: { assignedToId: userId }, data: { assignedToId: null } });
    return updated;
  }

  @Delete('users/:userId')
  async deleteUser(@Param('userId') userId: string) {
    const u = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!u || u.role === 'superadmin') throw new NotFoundException();
    await this.prisma.user.delete({ where: { id: userId } });
    return { deleted: userId };
  }

  // ---------- Payments
  @Get('payments')
  payments(@Query('status') status?: string) {
    return this.prisma.payment.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' }, take: 500,
      include: { workspace: { select: { id: true, name: true } } },
    });
  }

  // ---------- Platform settings (API keys)
  @Get('settings')
  getSettings() {
    return this.settings.list();
  }

  @Patch('settings')
  async saveSettings(@Body() body: Record<string, unknown>) {
    for (const [k, v] of Object.entries(body ?? {})) {
      if (!(k in SETTING_KEYS)) throw new BadRequestException(`Unknown setting ${k}`);
      if (typeof v !== 'string' || v.length > 500) throw new BadRequestException(`Invalid value for ${k}`);
      await this.settings.set(k as SettingKey, v.trim());
    }
    return this.settings.list();
  }

  // ---------- Subscriptions
  @Post('customers/:id/subscriptions')
  async activate(@Param('id') workspaceId: string, @Body() dto: ActivateDto, @CurrentUser() me: AuthUser) {
    const plan = await this.prisma.plan.findUnique({ where: { id: dto.planId } });
    if (!plan) throw new BadRequestException('Plan not found');
    return this.subs.activate(workspaceId, plan, { start: dto.start, durationDays: dto.durationDays, amountPaid: dto.amountPaid, note: dto.note, activatedBy: me.email });
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
