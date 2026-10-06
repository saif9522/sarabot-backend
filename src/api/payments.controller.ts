import { BadRequestException, Body, Controller, Get, Headers, HttpCode, Logger, NotFoundException, Post, RawBodyRequest, Req, ServiceUnavailableException } from '@nestjs/common';
import { Request } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { PrismaService } from '../prisma.service';
import { AuthUser, CurrentUser, Public, Roles, ws } from '../auth/auth.guard';
import { SettingsService } from '../settings/settings.service';
import { SubscriptionService } from '../billing/subscription.service';

class OrderDto { @IsString() @MinLength(1) planId!: string }
class VerifyDto {
  @IsString() @MinLength(5) @MaxLength(100) razorpay_order_id!: string;
  @IsString() @MinLength(5) @MaxLength(100) razorpay_payment_id!: string;
  @IsString() @MinLength(10) @MaxLength(200) razorpay_signature!: string;
}

const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Razorpay: create an order on our server, the customer pays in Razorpay Checkout,
 * we verify the signature and activate the plan. The webhook activates it too in case
 * the browser closes before verification; whichever arrives first wins, the other is a no-op.
 */
@Controller('payments')
export class PaymentsController {
  private readonly log = new Logger('Payments');
  constructor(private prisma: PrismaService, private settings: SettingsService, private subs: SubscriptionService) {}

  private keys() {
    const keyId = this.settings.get('RAZORPAY_KEY_ID');
    const secret = this.settings.get('RAZORPAY_KEY_SECRET');
    return keyId && secret ? { keyId, secret } : null;
  }

  @Roles('owner', 'admin')
  @Get('options')
  async options(@CurrentUser() u: AuthUser) {
    const plans = await this.prisma.plan.findMany({
      where: { active: true, trialForSignup: false, price: { gt: 0 } },
      orderBy: [{ sortOrder: 'asc' }, { durationDays: 'asc' }, { price: 'asc' }],
      select: { id: true, name: true, description: true, chatLimit: true, durationDays: true, price: true, currency: true, numbersLimit: true, agentsLimit: true },
    });
    const ws_ = await this.prisma.workspace.findUniqueOrThrow({ where: { id: ws(u) }, select: { name: true } });
    return { enabled: !!this.keys(), keyId: this.keys()?.keyId ?? null, plans, prefill: { name: u.name, email: u.email }, business: ws_.name };
  }

  @Roles('owner', 'admin')
  @Post('order')
  async order(@CurrentUser() u: AuthUser, @Body() dto: OrderDto) {
    const keys = this.keys();
    if (!keys) throw new ServiceUnavailableException('Online payment is not set up yet. Contact your administrator.');
    const plan = await this.prisma.plan.findFirst({ where: { id: dto.planId, active: true, price: { gt: 0 } } });
    if (!plan) throw new NotFoundException('Plan not available');
    const amount = Math.round(plan.price * 100);
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${keys.keyId}:${keys.secret}`).toString('base64')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ amount, currency: plan.currency, receipt: `ws_${ws(u).slice(-12)}_${Date.now()}`, notes: { workspaceId: ws(u), planId: plan.id, userEmail: u.email } }),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      this.log.error(`Razorpay order failed ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
      throw new BadRequestException(data?.error?.description || 'Could not start the payment. Check the Razorpay keys.');
    }
    await this.prisma.payment.create({
      data: { workspaceId: ws(u), planId: plan.id, planName: plan.name, amount, currency: plan.currency, razorpayOrderId: data.id, paidBy: u.email },
    });
    return { orderId: data.id, amount, currency: plan.currency, keyId: keys.keyId, planName: plan.name };
  }

  /** Called by the browser after Checkout succeeds. */
  @Roles('owner', 'admin')
  @Post('verify')
  @HttpCode(200)
  async verify(@CurrentUser() u: AuthUser, @Body() dto: VerifyDto) {
    const keys = this.keys();
    if (!keys) throw new ServiceUnavailableException('Online payment is not set up');
    const expected = createHmac('sha256', keys.secret).update(`${dto.razorpay_order_id}|${dto.razorpay_payment_id}`).digest('hex');
    if (!safeEqual(expected, dto.razorpay_signature)) throw new BadRequestException('Payment could not be verified');
    const p = await this.prisma.payment.findUnique({ where: { razorpayOrderId: dto.razorpay_order_id } });
    if (!p || p.workspaceId !== ws(u)) throw new NotFoundException('Order not found');
    const sub = await this.markPaid(dto.razorpay_order_id, dto.razorpay_payment_id, 'checkout');
    return { ok: true, subscription: sub };
  }

  /** Razorpay webhook (events: payment.captured, order.paid, payment.failed). */
  @Public()
  @Post('webhook')
  @HttpCode(200)
  async webhook(@Req() req: RawBodyRequest<Request>, @Headers('x-razorpay-signature') signature?: string) {
    const secret = this.settings.get('RAZORPAY_WEBHOOK_SECRET');
    if (!secret || !req.rawBody || !signature) throw new BadRequestException('Webhook not configured');
    const expected = createHmac('sha256', secret).update(req.rawBody).digest('hex');
    if (!safeEqual(expected, signature)) throw new BadRequestException('Bad signature');
    const body = req.body as any;
    const payment = body?.payload?.payment?.entity;
    const orderId: string | undefined = payment?.order_id || body?.payload?.order?.entity?.id;
    if (!orderId) return { ok: true };
    if (body.event === 'payment.captured' || body.event === 'order.paid') await this.markPaid(orderId, payment?.id ?? null, 'webhook');
    if (body.event === 'payment.failed') await this.prisma.payment.updateMany({ where: { razorpayOrderId: orderId, status: 'created' }, data: { status: 'failed' } });
    return { ok: true };
  }

  /** Idempotent: flips created→paid once and activates the plan in the same transaction. */
  private async markPaid(orderId: string, paymentId: string | null, via: string) {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.payment.updateMany({
        where: { razorpayOrderId: orderId, status: { in: ['created', 'failed'] } },
        data: { status: 'paid', razorpayPaymentId: paymentId, paidAt: new Date() },
      });
      const p = await tx.payment.findUnique({ where: { razorpayOrderId: orderId } });
      if (!p) throw new NotFoundException('Order not found');
      if (claimed.count === 0) return p.subscriptionId; // already handled
      const plan = p.planId ? await tx.plan.findUnique({ where: { id: p.planId } }) : null;
      if (!plan) throw new BadRequestException('The plan for this payment no longer exists. Contact support.');
      const sub = await this.subs.activate(p.workspaceId, plan, {
        start: 'after', amountPaid: p.amount / 100, note: `Razorpay ${paymentId ?? orderId}`, activatedBy: `razorpay (${via})`,
      }, tx);
      await tx.payment.update({ where: { id: p.id }, data: { subscriptionId: sub.id } });
      this.log.log(`Plan "${plan.name}" activated for workspace ${p.workspaceId} via ${via}`);
      return sub.id;
    });
  }

  @Roles('owner', 'admin')
  @Get()
  history(@CurrentUser() u: AuthUser) {
    return this.prisma.payment.findMany({ where: { workspaceId: ws(u) }, orderBy: { createdAt: 'desc' }, take: 50 });
  }
}
