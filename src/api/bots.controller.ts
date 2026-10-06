import { BadRequestException, Body, Controller, Delete, Get, NotFoundException, Param, Patch, Post, Put } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize, IsArray, IsBoolean, IsEmail, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateIf, ValidateNested,
} from 'class-validator';
import { PrismaService } from '../prisma.service';
import { BotEngine } from '../bot/bot.engine';
import { LlmService } from '../llm.service';
import { AuthUser, CurrentUser, Roles, ws } from '../auth/auth.guard';

class BotDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(80) name?: string;
  @IsOptional() @IsBoolean() aiEnabled?: boolean;
  @IsOptional() @IsString() @MaxLength(4000) instructions?: string;
  @IsOptional() @IsString() @MaxLength(200) companyName?: string;
  @IsOptional() @IsString() @MaxLength(500) location?: string;
  @IsOptional() @IsString() @MaxLength(200) industry?: string;
  @IsOptional() @IsString() @MaxLength(80) assistantName?: string;
  @IsOptional() @IsString() @MaxLength(2000) primaryGoal?: string;
  @IsOptional() @ValidateIf((o) => o.supportEmail !== '') @IsEmail() supportEmail?: string;
  @IsOptional() @IsString() @MaxLength(300) websiteUrl?: string;
  @IsOptional() @IsString() @MaxLength(300) phoneNumbers?: string;
  @IsOptional() @IsString() @MaxLength(50000) knowledge?: string;
  @IsOptional() @IsString() @MaxLength(1000) welcomeMessage?: string;
  @IsOptional() @IsString() @MaxLength(1000) fallbackMessage?: string;
  @IsOptional() @IsBoolean() useProducts?: boolean;
}

class StepDto {
  @IsIn(['text', 'image', 'document', 'delay']) type!: 'text' | 'image' | 'document' | 'delay';
  @IsOptional() @IsString() @MaxLength(4096) text?: string;
  @IsOptional() @IsString() @MaxLength(1000) media?: string;
  @IsOptional() @IsString() @MaxLength(200) fileName?: string;
  @IsOptional() @IsInt() @Min(0) @Max(30) delaySeconds?: number;
}
class FlowDto {
  @IsString() @MinLength(1) @MaxLength(120) name!: string;
  @IsString() @MaxLength(1000) keywords!: string;
  @IsIn(['contains', 'exact', 'starts']) matchType!: string;
  @IsBoolean() isNoMatch!: boolean;
  @IsBoolean() enabled!: boolean;
  @IsOptional() @IsInt() priority?: number;
  @IsArray() @ArrayMaxSize(30) @ValidateNested({ each: true }) @Type(() => StepDto) steps!: StepDto[];
}
class HistoryDto {
  @IsIn(['in', 'out']) direction!: 'in' | 'out';
  @IsString() body!: string;
}
class TestDto {
  @IsString() @MinLength(1) @MaxLength(2000) message!: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => HistoryDto) history?: HistoryDto[];
}

const withFlows = { flows: { orderBy: [{ isNoMatch: 'asc' as const }, { priority: 'desc' as const }, { createdAt: 'asc' as const }], include: { steps: { orderBy: { position: 'asc' as const } } } } };

@Roles('owner', 'admin')
@Controller('bots')
export class BotsController {
  constructor(private prisma: PrismaService, private engine: BotEngine, private llm: LlmService) {}

  /** Throws unless the bot belongs to the caller's workspace. */
  private async own(u: AuthUser, id: string) {
    const b = await this.prisma.bot.findFirst({ where: { id, workspaceId: ws(u) }, select: { id: true } });
    if (!b) throw new NotFoundException();
  }
  private async ownFlow(u: AuthUser, botId: string, flowId: string) {
    await this.own(u, botId);
    if (!(await this.prisma.flow.findFirst({ where: { id: flowId, botId } }))) throw new NotFoundException();
  }

  @Get()
  async list(@CurrentUser() u: AuthUser) {
    const bots = await this.prisma.bot.findMany({ where: { workspaceId: ws(u) }, orderBy: { createdAt: 'asc' }, include: { _count: { select: { flows: true, workingFor: true, offHoursFor: true } } } });
    return { aiAvailable: this.llm.enabled, bots };
  }

  @Get(':id')
  async get(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    const bot = await this.prisma.bot.findFirst({ where: { id, workspaceId: ws(u) }, include: withFlows });
    if (!bot) throw new NotFoundException();
    return { ...bot, aiAvailable: this.llm.enabled };
  }

  @Post()
  create(@CurrentUser() u: AuthUser, @Body() dto: BotDto) {
    return this.prisma.bot.create({ data: { ...dto, workspaceId: ws(u), name: dto.name || 'New bot' } });
  }

  @Patch(':id')
  async update(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: BotDto) {
    await this.own(u, id);
    return this.prisma.bot.update({ where: { id }, data: dto });
  }

  @Delete(':id')
  async remove(@CurrentUser() u: AuthUser, @Param('id') id: string) {
    await this.own(u, id);
    return this.prisma.bot.delete({ where: { id } });
  }

  // ---- Flows
  private validate(dto: FlowDto) {
    if (!dto.isNoMatch && !dto.keywords.split(',').some((k) => k.trim())) throw new BadRequestException('Add at least one trigger keyword, or mark the flow as "No match".');
    if (!dto.steps.length) throw new BadRequestException('Add at least one message to the flow.');
    for (const s of dto.steps) {
      if (s.type === 'text' && !s.text?.trim()) throw new BadRequestException('A text message is empty.');
      if ((s.type === 'image' || s.type === 'document') && !s.media) throw new BadRequestException(`Upload a file or paste a link for the ${s.type}.`);
    }
  }

  private async saveFlow(botId: string, dto: FlowDto, flowId?: string) {
    this.validate(dto);
    return this.prisma.$transaction(async (tx) => {
      if (dto.isNoMatch) await tx.flow.updateMany({ where: { botId, ...(flowId ? { id: { not: flowId } } : {}) }, data: { isNoMatch: false } });
      const data = { name: dto.name.trim(), keywords: dto.keywords, matchType: dto.matchType, isNoMatch: dto.isNoMatch, enabled: dto.enabled, priority: dto.priority ?? 0 };
      const flow = flowId ? await tx.flow.update({ where: { id: flowId }, data }) : await tx.flow.create({ data: { ...data, botId } });
      await tx.flowStep.deleteMany({ where: { flowId: flow.id } });
      await tx.flowStep.createMany({
        data: dto.steps.map((s, i) => ({
          flowId: flow.id, position: i, type: s.type, text: s.text ?? '', media: s.media ?? '', fileName: s.fileName ?? '', delaySeconds: s.delaySeconds ?? 0,
        })),
      });
      return tx.flow.findUniqueOrThrow({ where: { id: flow.id }, include: { steps: { orderBy: { position: 'asc' } } } });
    });
  }

  @Post(':id/flows')
  async addFlow(@CurrentUser() u: AuthUser, @Param('id') botId: string, @Body() dto: FlowDto) {
    await this.own(u, botId);
    return this.saveFlow(botId, dto);
  }

  @Put(':id/flows/:flowId')
  async updateFlow(@CurrentUser() u: AuthUser, @Param('id') botId: string, @Param('flowId') flowId: string, @Body() dto: FlowDto) {
    await this.ownFlow(u, botId, flowId);
    return this.saveFlow(botId, dto, flowId);
  }

  @Patch(':id/flows/:flowId')
  async toggleFlow(@CurrentUser() u: AuthUser, @Param('id') botId: string, @Param('flowId') flowId: string, @Body() body: { enabled?: boolean }) {
    await this.ownFlow(u, botId, flowId);
    return this.prisma.flow.update({ where: { id: flowId }, data: { enabled: !!body.enabled } });
  }

  @Post(':id/flows/:flowId/duplicate')
  async duplicateFlow(@CurrentUser() u: AuthUser, @Param('id') botId: string, @Param('flowId') flowId: string) {
    await this.ownFlow(u, botId, flowId);
    const f = await this.prisma.flow.findUniqueOrThrow({ where: { id: flowId }, include: { steps: true } });
    return this.prisma.flow.create({
      data: {
        botId, name: `${f.name} (copy)`, keywords: f.keywords, matchType: f.matchType, isNoMatch: false, enabled: false, priority: f.priority,
        steps: { create: f.steps.map(({ position, type, text, media, fileName, delaySeconds }) => ({ position, type, text, media, fileName, delaySeconds })) },
      },
    });
  }

  @Delete(':id/flows/:flowId')
  async removeFlow(@CurrentUser() u: AuthUser, @Param('id') botId: string, @Param('flowId') flowId: string) {
    await this.ownFlow(u, botId, flowId);
    return this.prisma.flow.delete({ where: { id: flowId } });
  }

  /** Try the bot without WhatsApp: nothing is sent or saved. */
  @Post(':id/test')
  async test(@CurrentUser() u: AuthUser, @Param('id') id: string, @Body() dto: TestDto) {
    const bot = await this.prisma.bot.findFirst({ where: { id, workspaceId: ws(u) }, include: { flows: { include: { steps: true } } } });
    if (!bot) throw new NotFoundException();
    const history = [...(dto.history || []), { direction: 'in' as const, body: dto.message }];
    return this.engine.decide(bot, dto.message, dto.message, history, { name: 'Test customer', waId: '910000000000' });
  }
}
