import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query, Res } from '@nestjs/common';
import { Response } from 'express';
import { Prisma } from '@prisma/client';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength, ValidateIf } from 'class-validator';
import { PrismaService } from '../prisma.service';
import { InboundService } from '../whatsapp/inbound.service';
import { AuthUser, CurrentUser, Roles, ws } from '../auth/auth.guard';

class SendDto { @IsString() @MinLength(1) @MaxLength(4096) text!: string }
class ContactPatchDto {
  @IsOptional() @IsBoolean() botPaused?: boolean;
  @IsOptional() @IsBoolean() optedOut?: boolean;
  @IsOptional() @IsBoolean() needsHuman?: boolean;
  @IsOptional() @IsString() @MaxLength(300) tags?: string;
  /** null = unassign */
  @IsOptional() @ValidateIf((o) => o.assignedToId !== null) @IsString() assignedToId?: string | null;
}

const isManager = (u: AuthUser) => u.effectiveRole === 'owner' || u.effectiveRole === 'admin';

@Controller()
export class ChatsController {
  constructor(private prisma: PrismaService, private inbound: InboundService) {}

  /** Chats this person may see: managers see all; agents see theirs (+ unassigned if allowed). */
  private visible(u: AuthUser): Prisma.ContactWhereInput {
    const base: Prisma.ContactWhereInput = { account: { workspaceId: ws(u) } };
    if (isManager(u)) return base;
    return { ...base, OR: [{ assignedToId: u.id }, ...(u.seeUnassigned ? [{ assignedToId: null }] : [])] };
  }

  private async contact(u: AuthUser, id: string) {
    const c = await this.prisma.contact.findFirst({ where: { id, ...this.visible(u) } });
    if (!c) throw new NotFoundException();
    return c;
  }

  @Get('chats')
  async conversations(@CurrentUser() u: AuthUser, @Query('accountId') accountId?: string, @Query('filter') filter?: string) {
    const and: Prisma.ContactWhereInput[] = [this.visible(u)];
    if (accountId) and.push({ accountId });
    if (filter === 'human') and.push({ needsHuman: true });
    if (filter === 'mine') and.push({ assignedToId: u.id });
    if (filter === 'unassigned') and.push({ assignedToId: null });
    const rows = await this.prisma.contact.findMany({
      where: { AND: and },
      orderBy: { lastMessageAt: 'desc' },
      take: 300,
      include: {
        messages: { orderBy: { createdAt: 'desc' }, take: 1 },
        account: { select: { label: true, phone: true } },
        assignedTo: { select: { id: true, name: true } },
      },
    });
    return rows.map(({ messages, ...c }) => ({ ...c, lastMessage: messages[0] ?? null }));
  }

  @Get('chats/:contactId')
  async thread(@CurrentUser() u: AuthUser, @Param('contactId') id: string) {
    await this.contact(u, id);
    const contact = await this.prisma.contact.findUniqueOrThrow({
      where: { id },
      include: { account: { select: { id: true, label: true, phone: true } }, assignedTo: { select: { id: true, name: true } } },
    });
    const messages = await this.prisma.message.findMany({ where: { contactId: id }, orderBy: { createdAt: 'asc' }, take: 1000 });
    return { contact, messages };
  }

  /** People a chat can be assigned to. */
  @Get('team')
  async team(@CurrentUser() u: AuthUser) {
    return this.prisma.user.findMany({ where: { workspaceId: ws(u), active: true }, select: { id: true, name: true, role: true }, orderBy: { name: 'asc' } });
  }

  @Post('chats/:contactId/send')
  async send(@CurrentUser() u: AuthUser, @Param('contactId') id: string, @Body() dto: SendDto) {
    const c = await this.contact(u, id);
    try {
      const msg = await this.inbound.send(c.accountId, c.id, c.waId, dto.text, 'human');
      // You're talking to this person now: pause the bot and (if nobody has it) take the chat.
      await this.prisma.contact.update({ where: { id: c.id }, data: { botPaused: true, ...(c.assignedToId ? {} : { assignedToId: u.id }) } });
      return msg;
    } catch (e) {
      throw new BadRequestException((e as Error).message);
    }
  }

  @Patch('contacts/:contactId')
  async update(@CurrentUser() u: AuthUser, @Param('contactId') id: string, @Body() dto: ContactPatchDto) {
    const c = await this.contact(u, id);
    if (dto.assignedToId !== undefined) {
      if (!isManager(u)) {
        // Agents may take an unassigned chat, or give back their own.
        const take = dto.assignedToId === u.id && !c.assignedToId;
        const giveBack = dto.assignedToId === null && c.assignedToId === u.id;
        if (!take && !giveBack) throw new ForbiddenException('Only an owner or admin can reassign chats');
      } else if (dto.assignedToId && !(await this.prisma.user.findFirst({ where: { id: dto.assignedToId, workspaceId: ws(u), active: true } }))) {
        throw new BadRequestException('That team member was not found');
      }
    }
    if ((dto.optedOut !== undefined || dto.tags !== undefined) && !isManager(u) && c.assignedToId !== u.id) {
      throw new ForbiddenException('Only the assigned agent, an owner or an admin can change this');
    }
    return this.prisma.contact.update({ where: { id }, data: dto });
  }

  @Roles('owner', 'admin')
  @Get('subscribers')
  async subscribers(@CurrentUser() u: AuthUser, @Query('q') q?: string, @Query('accountId') accountId?: string) {
    return this.prisma.contact.findMany({
      where: {
        account: { workspaceId: ws(u) },
        ...(accountId ? { accountId } : {}),
        ...(q ? { OR: [{ name: { contains: q } }, { waId: { contains: q.replace(/\D/g, '') || q } }, { tags: { contains: q } }] } : {}),
      },
      orderBy: { firstSeenAt: 'desc' },
      take: 1000,
      include: { account: { select: { label: true, phone: true } }, assignedTo: { select: { id: true, name: true } } },
    });
  }

  @Roles('owner', 'admin')
  @Get('subscribers.csv')
  async exportCsv(@CurrentUser() u: AuthUser, @Res() res: Response) {
    const rows = await this.prisma.contact.findMany({
      where: { account: { workspaceId: ws(u) } }, orderBy: { firstSeenAt: 'asc' },
      include: { account: { select: { label: true, phone: true } }, assignedTo: { select: { name: true } } },
    });
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [
      ['Name', 'Number', 'Linked number', 'Agent', 'Tags', 'Messages', 'First seen', 'Last message', 'Unsubscribed'].map(esc).join(','),
      ...rows.map((c) => [c.name, `+${c.waId}`, c.account.phone ? `+${c.account.phone}` : c.account.label, c.assignedTo?.name, c.tags, c.messageCount, c.firstSeenAt.toISOString(), c.lastMessageAt.toISOString(), c.optedOut ? 'yes' : 'no'].map(esc).join(',')),
    ];
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="subscribers.csv"');
    res.send('\uFEFF' + lines.join('\r\n'));
  }
}
