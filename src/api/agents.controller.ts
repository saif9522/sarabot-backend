import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, NotFoundException, Param, Patch, Post } from '@nestjs/common';
import { IsBoolean, IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PrismaService } from '../prisma.service';
import { AuthUser, CurrentUser, Roles, ws } from '../auth/auth.guard';
import { hashPassword } from '../auth/crypto';
import { SubscriptionService } from '../billing/subscription.service';

class AgentDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsEmail() email!: string;
  @IsOptional() @IsString() @MaxLength(20) mobile?: string;
  @IsString() @MinLength(8) @MaxLength(200) password!: string;
  @IsIn(['admin', 'agent']) role!: 'admin' | 'agent';
  @IsOptional() @IsBoolean() seeUnassigned?: boolean;
}
class AgentPatchDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120) name?: string;
  @IsOptional() @IsString() @MaxLength(20) mobile?: string;
  @IsOptional() @IsString() @MinLength(8) @MaxLength(200) password?: string;
  @IsOptional() @IsIn(['admin', 'agent']) role?: 'admin' | 'agent';
  @IsOptional() @IsBoolean() seeUnassigned?: boolean;
  @IsOptional() @IsBoolean() active?: boolean;
}
class TeamSettingsDto { @IsBoolean() autoAssign!: boolean }

const PUBLIC_FIELDS = { id: true, name: true, email: true, mobile: true, role: true, active: true, seeUnassigned: true, createdAt: true, lastLoginAt: true } as const;

/** Owners and admins manage the team. Agents (and admins) count toward the plan's agent limit. */
@Roles('owner', 'admin')
@Controller('agents')
export class AgentsController {
  constructor(private prisma: PrismaService, private subs: SubscriptionService) {}

  @Get()
  async list(@CurrentUser() u: AuthUser) {
    const [users, workspace, limits] = await Promise.all([
      this.prisma.user.findMany({ where: { workspaceId: ws(u) }, select: { ...PUBLIC_FIELDS, _count: { select: { assigned: true } } }, orderBy: { createdAt: 'asc' } }),
      this.prisma.workspace.findUniqueOrThrow({ where: { id: ws(u) }, select: { autoAssign: true } }),
      this.subs.limits(ws(u)),
    ]);
    const used = users.filter((x) => x.role !== 'owner').length;
    return { users, autoAssign: workspace.autoAssign, agentsLimit: limits.agentsLimit, agentsUsed: used };
  }

  @Post()
  async create(@CurrentUser() u: AuthUser, @Body() dto: AgentDto) {
    const { agentsLimit } = await this.subs.limits(ws(u));
    const used = await this.prisma.user.count({ where: { workspaceId: ws(u), role: { in: ['admin', 'agent'] } } });
    if (used >= agentsLimit) throw new ForbiddenException(`Your plan allows ${agentsLimit} agent${agentsLimit === 1 ? '' : 's'}. Ask your administrator to upgrade.`);
    const email = dto.email.trim().toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('A user with this email already exists');
    return this.prisma.user.create({
      data: { workspaceId: ws(u), email, name: dto.name.trim(), mobile: dto.mobile ?? '', role: dto.role, seeUnassigned: dto.seeUnassigned ?? true, passwordHash: await hashPassword(dto.password) },
      select: PUBLIC_FIELDS,
    });
  }

  private async target(u: AuthUser, id: string) {
    const t = await this.prisma.user.findFirst({ where: { id, workspaceId: ws(u) } });
    if (!t) throw new NotFoundException();
    if (t.role === 'owner') throw new ForbiddenException('The owner account can only be changed by the Super Admin');
    return t;
  }

  @Patch(':id')
  async update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: AgentPatchDto) {
    await this.target(u, id);
    if (id === u.id && (dto.active === false || dto.role === 'agent')) throw new BadRequestException('You cannot disable or demote yourself');
    const { password, ...rest } = dto;
    const user = await this.prisma.user.update({ where: { id }, data: { ...rest, ...(password ? { passwordHash: await hashPassword(password) } : {}) }, select: PUBLIC_FIELDS });
    if (dto.active === false) await this.prisma.contact.updateMany({ where: { assignedToId: id }, data: { assignedToId: null } });
    return user;
  }

  @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.target(u, id);
    if (id === u.id) throw new BadRequestException('You cannot delete yourself');
    await this.prisma.user.delete({ where: { id } }); // their chats become unassigned
    return { deleted: id };
  }

  @Patch()
  settings(@CurrentUser() u: AuthUser, @Body() dto: TeamSettingsDto) {
    return this.prisma.workspace.update({ where: { id: ws(u) }, data: { autoAssign: dto.autoAssign }, select: { autoAssign: true } });
  }
}
