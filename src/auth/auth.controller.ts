import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Ip, Post, Query, Res, UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'crypto';
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
class OtpRequestDto { @IsEmail() email!: string }
class OtpVerifyDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(6) @MaxLength(6) code!: string;
}
class ResetDto {
  @IsString() @MinLength(20) @MaxLength(200) token!: string;
  @IsString() @MinLength(8) @MaxLength(200) password!: string;
}
class PasswordDto {
  @IsString() @MinLength(1) current!: string;
  @IsString() @MinLength(8) @MaxLength(200) next!: string;
}

// Over https (COOKIE_SECURE=true) the dashboard and API usually live on different domains
// (e.g. *.vercel.app and *.onrender.com), which needs SameSite=None; locally Lax is enough.
const secureCookies = process.env.COOKIE_SECURE === 'true';
const cookieOpts = { httpOnly: true, sameSite: (secureCookies ? 'none' : 'lax') as 'none' | 'lax', secure: secureCookies, path: '/' };

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

  // ---------- Email OTP sign-in
  private static readonly OTP_TTL_MS = 10 * 60_000;
  private static readonly OTP_MAX_ATTEMPTS = 5;
  private otpHash(userId: string, code: string) {
    return createHmac('sha256', `otp:${process.env.SESSION_SECRET || 'dev-only-secret-change-me-dev-only-secret'}`).update(`${userId}:${code}`).digest('hex');
  }

  /** Sends a 6-digit code. Same reply whether or not the email has an account. */
  @Public()
  @Post('otp/request')
  @HttpCode(200)
  async otpRequest(@Body() dto: OtpRequestDto, @Ip() ip: string) {
    const email = dto.email.trim().toLowerCase();
    const reply = { ok: true, message: `If ${email} has an account, a 6-digit code is on its way. It works for 10 minutes.` };
    if (this.limited(`otp-ip:${ip}`, 20, 3600_000)) throw new ForbiddenException('Too many code requests from this network. Try again later.');
    if (this.limited(`otp-gap:${email}`, 1, 55_000)) throw new ForbiddenException('Please wait a minute before asking for another code.');
    if (this.limited(`otp:${email}`, 6, 3600_000)) return reply;

    const u = await this.prisma.user.findUnique({ where: { email }, include: { workspace: { select: { status: true } } } });
    if (!u || !u.active || (u.role !== 'superadmin' && u.workspace?.status !== 'active')) return reply;

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.prisma.loginCode.deleteMany({ where: { userId: u.id, usedAt: null } }); // only the newest code works
    await this.prisma.loginCode.create({ data: { userId: u.id, codeHash: this.otpHash(u.id, code), expiresAt: new Date(Date.now() + AuthController.OTP_TTL_MS) } });
    const text = `Your Sarabot sign-in code is ${code}\n\nIt works for 10 minutes. If you didn't try to sign in, ignore this email.`;
    const html = `<p>Your Sarabot sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:6px;font-family:monospace">${code}</p>`
      + `<p>It works for 10 minutes. If you didn't try to sign in, ignore this email — nobody can sign in without this code.</p>`;
    try {
      await this.mailer.send(email, `${code} is your Sarabot sign-in code`, text, html);
    } catch (e) {
      console.error('Sign-in code email failed:', (e as Error).message);
    }
    return reply;
  }

  @Public()
  @Post('otp/verify')
  @HttpCode(200)
  async otpVerify(@Body() dto: OtpVerifyDto, @Res({ passthrough: true }) res: Response) {
    const email = dto.email.trim().toLowerCase();
    const wrong = new UnauthorizedException('That code is wrong or has expired. Check the latest email or ask for a new code.');
    if (!/^\d{6}$/.test(dto.code)) throw wrong;
    const u = await this.prisma.user.findUnique({ where: { email }, include: { workspace: { select: { status: true } } } });
    if (!u || !u.active || (u.role !== 'superadmin' && u.workspace?.status !== 'active')) throw wrong;
    const lc = await this.prisma.loginCode.findFirst({ where: { userId: u.id, usedAt: null }, orderBy: { createdAt: 'desc' } });
    if (!lc || lc.expiresAt < new Date() || lc.attempts >= AuthController.OTP_MAX_ATTEMPTS) throw wrong;

    // Count the attempt first, atomically, so parallel guesses can't exceed the limit.
    const counted = await this.prisma.loginCode.updateMany({ where: { id: lc.id, usedAt: null, attempts: { lt: AuthController.OTP_MAX_ATTEMPTS } }, data: { attempts: { increment: 1 } } });
    if (counted.count !== 1) throw wrong;
    const expected = Buffer.from(lc.codeHash, 'hex');
    const got = Buffer.from(this.otpHash(u.id, dto.code), 'hex');
    if (expected.length !== got.length || !timingSafeEqual(expected, got)) {
      if (lc.attempts + 1 >= AuthController.OTP_MAX_ATTEMPTS) throw new UnauthorizedException('Too many wrong codes. Ask for a new code.');
      throw wrong;
    }
    const used = await this.prisma.loginCode.updateMany({ where: { id: lc.id, usedAt: null }, data: { usedAt: new Date() } });
    if (used.count !== 1) throw wrong; // already used by a parallel request
    await this.prisma.user.update({ where: { id: u.id }, data: { lastLoginAt: new Date() } });
    res.cookie(SESSION_COOKIE, signToken(u.id, u.sessionVersion), { ...cookieOpts, maxAge: 7 * 86400_000 });
    res.clearCookie(ACT_AS_COOKIE, cookieOpts);
    return { ok: true, role: u.role };
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
    const text = `Hi ${u.name},\n\nSomeone asked to reset the password for your Sarabot account (${email}).\nSet a new password here (works for 1 hour):\n${link}\n\nIf this wasn't you, ignore this email — your password stays the same.`;
    const html = `<p>Hi ${u.name.replace(/[<>&"]/g, '')},</p><p>Someone asked to reset the password for your Sarabot account.</p>`
      + `<p><a href="${link}" style="display:inline-block;background:#0B7A5C;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Set a new password</a></p>`
      + `<p>The link works for 1 hour. If this wasn't you, ignore this email — your password stays the same.</p>`;
    try {
      await this.mailer.send(email, 'Reset your Sarabot password', text, html);
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
