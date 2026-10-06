import { Body, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { AuthUser, CurrentUser, Roles, ws } from '../auth/auth.guard';
import { SubscriptionService } from '../billing/subscription.service';
import { IsBoolean, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { PrismaService } from '../prisma.service';
import { SessionManager } from '../whatsapp/session.manager';
import { isWorkingHours } from '../bot/bot.logic';

class CreateAccountDto {
  @IsString() @MaxLength(60) label!: string;
}
class UpdateAccountDto {
  @IsOptional() @IsString() @MaxLength(60) label?: string;
  @IsOptional() @IsBoolean() botEnabled?: boolean;
  @IsOptional() @IsString() workingBotId?: string | null;
  @IsOptional() @IsString() offHoursBotId?: string | null;
  @IsOptional() @Matches(/^([0-6](,[0-6])*)?$/) workDays?: string;
  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) workStart?: string;
  @IsOptional() @Matches(/^([01]\d|2[0-3]):[0-5]\d$/) workEnd?: string;
  @IsOptional() @IsString() timezone?: string;
}

@Controller('accounts')
export class AccountsController {
  constructor(private prisma: PrismaService, private sessions: SessionManager, private subs: SubscriptionService) {}

  private view<T extends { id: string; workDays: string; workStart: string; workEnd: string; timezone: string }>(a: T) {
    return { ...a, session: this.sessions.state(a.id), workingNow: isWorkingHours(a) };
  }

  @Get()
  async list(@CurrentUser() u: AuthUser) {
    const rows = await this.prisma.account.findMany({ where: { workspaceId: ws(u) }, orderBy: { createdAt: 'asc' }, include: { _count: { select: { contacts: true } } } });
    return rows.map((a) => this.view(a));
  }

  @Get(':id')
  async get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const a = await this.prisma.account.findFirst({ where: { id, workspaceId: ws(u) }, include: { _count: { select: { contacts: true } } } });
    if (!a) throw new NotFoundException();
    return this.view(a);
  }

  /** Add a number and start linking it (a QR code follows over the socket / polling). */
  @Roles('owner', 'admin')
  @Post()
  async create(@CurrentUser() u: AuthUser, @Body() dto: CreateAccountDto) {
    const { numbersLimit } = await this.subs.limits(ws(u));
    if ((await this.prisma.account.count({ where: { workspaceId: ws(u) } })) >= numbersLimit) {
      throw new ForbiddenException(`Your plan allows ${numbersLimit} WhatsApp number${numbersLimit === 1 ? '' : 's'}. Ask your administrator to upgrade.`);
    }
    const firstBot = await this.prisma.bot.findFirst({ where: { workspaceId: ws(u) }, orderBy: { createdAt: 'asc' } });
    const a = await this.prisma.account.create({ data: { workspaceId: ws(u), label: dto.label, workingBotId: firstBot?.id, offHoursBotId: firstBot?.id } });
    await this.sessions.start(a.id);
    return this.get(u, a.id);
  }

  @Roles('owner', 'admin')
  @Post(':id/link')
  async link(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.get(u, id);
    await this.sessions.start(id);
    return this.get(u, id);
  }

  @Roles('owner', 'admin')
  @Post(':id/unlink')
  async unlink(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.get(u, id);
    await this.sessions.logout(id);
    return this.get(u, id);
  }

  @Roles('owner', 'admin')
  @Patch(':id')
  async update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: UpdateAccountDto) {
    await this.get(u, id);
    const data: Record<string, unknown> = { ...dto };
    for (const k of ['workingBotId', 'offHoursBotId'] as const) {
      if (dto[k] === '') data[k] = null;
      else if (dto[k] && !(await this.prisma.bot.findFirst({ where: { id: dto[k]!, workspaceId: ws(u) } }))) throw new NotFoundException('Bot not found');
    }
    await this.prisma.account.update({ where: { id }, data });
    return this.get(u, id);
  }

  @Roles('owner', 'admin')
  @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.get(u, id);
    await this.sessions.logout(id);
    this.sessions.forget(id);
    await this.prisma.account.delete({ where: { id } });
    return { deleted: id };
  }
}
