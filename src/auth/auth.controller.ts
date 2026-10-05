import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Ip, Post, Query, Res, UnauthorizedException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { Response } from 'express';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { PrismaService } from '../prisma.service';
import { AnyUser, AuthUser, CurrentUser, Public } from './auth.guard';
import { ACT_AS_COOKIE, SESSION_COOKIE, hashPassword, signToken, verifyPassword } from './crypto';
import { SubscriptionService } from '../billing/subscription.service';
import { MailerService } from './mailer.service';
import { SettingsService } from '../settings/settings.service';

class LoginDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(1) @MaxLength(200) password!: string;
}
class SignupDto {
  @IsString() @MinLength(2) @MaxLength(120) businessName!: string;
  @IsString() @MinLength(2) @MaxLength(120) name!: string;
  @IsEmail() email!: string;
  @IsOptional() @IsString() @MaxLength(20) mobile?: string;
  @IsString() @MinLength(8) @MaxLength(200) password!: string;
}
class ForgotDto { @IsEmail() email!: string }
class ResetDto {
  @IsString() @MinLength(20) @MaxLength(200) token!: string;
  @IsString() @MinLength(8) @MaxLength(200) password!: string;
}
class PasswordDto {
  @IsString() @MinLength(1) current!: string;
  @IsString() @MinLength(8) @MaxLength(200) next!: string;
}

const cookieOpts = { httpOnly: true, sameSite: 'lax' as const, secure: process.env.COOKIE_SECURE === 'true', path: '/' };

@Controller('auth')
export class AuthController {
  private attempts = new Map<string, { n: number; until: number }>();
  /** Simple in-memory limits: key -> timestamps */
  private hits = new Map<string, number[]>();
  constructor(private prisma: PrismaService, private subs: SubscriptionService, private mailer: MailerService, private settings: SettingsService) {}

  private limited(key: string, max: number, windowMs: number) {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (list.length >= max) return true;
    list.push(now);
    this.hits.set(key, list);
    return false;
  }

  /** Public: whether self sign-up is open and what new accounts get. */
  @Public()
  @Get('signup-info')
  async signupInfo() {
    const trial = await this.prisma.plan.findFirst({ where: { trialForSignup: true, active: true }, select: { name: true, chatLimit: true, durationDays: true } });
    return { open: this.settings.get('ALLOW_SIGNUP', 'true') !== 'false', trial, emailConfigured: this.mailer.configured };
  }

  /** A business signs itself up: creates its workspace with this person as Owner. */
  @Public()
  @Post('signup')
  async signup(@Body() dto: SignupDto, @Ip() ip: string, @Res({ passthrough: true }) res: Response) {
    if (this.settings.get('ALLOW_SIGNUP', 'true') === 'false') throw new ForbiddenException('Sign-up is closed. Contact us to get an account.');
    if (this.limited(`signup:${ip}`, 5, 3600_000)) throw new ForbiddenException('Too many sign-ups from this network. Try again later.');
    const email = dto.email.trim().toLowerCase();
    if (await this.prisma.user.findUnique({ where: { email } })) throw new ConflictException('An account with this email already exists. Sign in or reset your password.');
    const trial = await this.prisma.plan.findFirst({ where: { trialForSignup: true, active: true } });
    const now = new Date();
    const ws = await this.prisma.workspace.create({
      data: {
        name: dto.businessName.trim(),
        notes: 'Signed up online',
        users: { create: { email, name: dto.name.trim(), mobile: dto.mobile?.trim() ?? '', role: 'owner', passwordHash: await hashPassword(dto.password) } },
        ...(trial ? { subscriptions: { create: {
          planId: trial.id, planName: trial.name, chatLimit: trial.chatLimit, numbersLimit: trial.numbersLimit, agentsLimit: trial.agentsLimit,
          startsAt: now, endsAt: new Date(now.getTime() + trial.durationDays * 86400_000), amountPaid: 0, currency: trial.currency, note: 'Free trial on sign-up', activatedBy: 'sign-up',
        } } } : {}),
      },
      include: { users: true },
    });
    const owner = ws.users[0];
    res.cookie(SESSION_COOKIE, signToken(owner.id, owner.sessionVersion), { ...cookieOpts, maxAge: 7 * 86400_000 });
    return { ok: true, role: 'owner', trial: !!trial };
  }

  /** Always answers the same way, so nobody can find out which emails have accounts. */
  @Public()
  @Post('forgot')
  @HttpCode(200)
  async forgot(@Body() dto: ForgotDto, @Ip() ip: string) {
    const email = dto.email.trim().toLowerCase();
    const reply = { ok: true, message: 'If an account exists for this email, a reset link is on its way. It works for 1 hour.' };
    if (this.limited(`forgot:${email}`, 3, 3600_000) || this.limited(`forgot-ip:${ip}`, 10, 3600_000)) return reply;
    const u = await this.prisma.user.findUnique({ where: { email } });
    if (!u || !u.active) return reply;

    const token = randomBytes(32).toString('base64url');
    await this.prisma.passwordReset.deleteMany({ where: { userId: u.id, usedAt: null } });
    await this.prisma.passwordReset.create({
      data: { userId: u.id, tokenHash: createHash('sha256').update(token).digest('hex'), expiresAt: new Date(Date.now() + 3600_000) },
    });
    const link = `${process.env.FRONTEND_URL || 'http://localhost:3100'}/reset-password?token=${token}`;
    const text = `Hi ${u.name},\n\nSomeone asked to reset the password for your SAIF Chat account (${email}).\nSet a new password here (works for 1 hour):\n${link}\n\nIf this wasn't you, ignore this email — your password stays the same.`;
    const html = `<p>Hi ${u.name.replace(/[<>&"]/g, '')},</p><p>Someone asked to reset the password for your SAIF Chat account.</p>`
      + `<p><a href="${link}" style="display:inline-block;background:#0B7A5C;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Set a new password</a></p>`
      + `<p>The link works for 1 hour. If this wasn't you, ignore this email — your password stays the same.</p>`;
    try {
      await this.mailer.send(email, 'Reset your SAIF Chat password', text, html);
    } catch (e) {
      // Don't reveal mail problems to the requester; the operator sees them in the log.
      console.error('Password reset email failed:', (e as Error).message);
    }
    return reply;
  }

  private async findReset(token: string) {
    const r = await this.prisma.passwordReset.findUnique({ where: { tokenHash: createHash('sha256').update(token).digest('hex') }, include: { user: true } });
    return r && !r.usedAt && r.expiresAt > new Date() && r.user.active ? r : null;
  }

  @Public()
  @Get('reset-check')
  async resetCheck(@Query('token') token = '') {
    const r = token.length >= 20 ? await this.findReset(token) : null;
    return { valid: !!r, email: r ? r.user.email.replace(/^(.{2}).*(@.*)$/, '$1•••$2') : null };
  }

  @Public()
  @Post('reset')
  @HttpCode(200)
  async reset(@Body() dto: ResetDto) {
    const r = await this.findReset(dto.token);
    if (!r) throw new BadRequestException('This reset link is invalid or has expired. Ask for a new one.');
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: r.userId }, data: { passwordHash: await hashPassword(dto.password), sessionVersion: { increment: 1 } } }),
      this.prisma.passwordReset.update({ where: { id: r.id }, data: { usedAt: new Date() } }),
      this.prisma.passwordReset.deleteMany({ where: { userId: r.userId, usedAt: null } }),
    ]);
    return { ok: true };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  async login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    const email = dto.email.trim().toLowerCase();
    const a = this.attempts.get(email);
    if (a && a.until > Date.now()) throw new UnauthorizedException('Too many attempts. Try again in a few minutes.');
    const u = await this.prisma.user.findUnique({ where: { email }, include: { workspace: true } });
    const ok = u && u.active && (await verifyPassword(dto.password, u.passwordHash));
    if (!ok) {
      const n = (a?.n ?? 0) + 1;
      this.attempts.set(email, { n, until: n >= 5 ? Date.now() + 5 * 60_000 : 0 });
      throw new UnauthorizedException('Wrong email or password');
    }
    if (u.role !== 'superadmin' && u.workspace?.status !== 'active') throw new UnauthorizedException('This account is suspended. Contact your administrator.');
    this.attempts.delete(email);
    await this.prisma.user.update({ where: { id: u.id }, data: { lastLoginAt: new Date() } });
    res.cookie(SESSION_COOKIE, signToken(u.id, u.sessionVersion), { ...cookieOpts, maxAge: 7 * 86400_000 });
    res.clearCookie(ACT_AS_COOKIE, cookieOpts);
    return { ok: true, role: u.role };
  }

  @Public()
  @Post('logout')
  @HttpCode(200)
  logout(@Res({ passthrough: true }) res: Response) {
    res.clearCookie(SESSION_COOKIE, cookieOpts);
    res.clearCookie(ACT_AS_COOKIE, cookieOpts);
    return { ok: true };
  }

  @AnyUser()
  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const workspace = user.workspaceId ? await this.prisma.workspace.findUnique({ where: { id: user.workspaceId }, select: { id: true, name: true, autoAssign: true } }) : null;
    const plan = user.workspaceId ? await this.subs.status(user.workspaceId) : null;
    return { user, workspace, plan };
  }

  @AnyUser()
  @Post('password')
  @HttpCode(200)
  async changePassword(@CurrentUser() user: AuthUser, @Body() dto: PasswordDto, @Res({ passthrough: true }) res: Response) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    if (!(await verifyPassword(dto.current, u.passwordHash))) throw new UnauthorizedException('Current password is wrong');
    // Sign out other devices; keep this one signed in.
    const updated = await this.prisma.user.update({ where: { id: u.id }, data: { passwordHash: await hashPassword(dto.next), sessionVersion: { increment: 1 } } });
    res.cookie(SESSION_COOKIE, signToken(u.id, updated.sessionVersion), { ...cookieOpts, maxAge: 7 * 86400_000 });
    return { ok: true };
  }
}

export { cookieOpts };
