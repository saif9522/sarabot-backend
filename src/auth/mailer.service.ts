import { Global, Injectable, Logger, Module } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

/**
 * Sends email. In order of preference:
 *  1. Brevo HTTP API  (BREVO_API_KEY)  — works on Render free, which blocks SMTP ports 25/465/587
 *  2. Resend HTTP API (RESEND_API_KEY) — needs your own verified domain to email other people
 *  3. SMTP            (SMTP_HOST ...)  — only on hosts that allow SMTP (Render paid, VPS, local)
 * Without any of these the message is printed in the logs instead, so resets still work in a pinch.
 *
 * Sender: MAIL_FROM_EMAIL (+ optional MAIL_FROM_NAME), or SMTP_FROM / SMTP_USER.
 */
@Injectable()
export class MailerService {
  private readonly log = new Logger('Email');
  private transport = process.env.SMTP_HOST
    ? nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: Number(process.env.SMTP_PORT) === 465,
        auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS } : undefined,
        connectionTimeout: 10_000,
      })
    : null;

  private get provider(): 'brevo' | 'resend' | 'smtp' | null {
    if (process.env.BREVO_API_KEY) return 'brevo';
    if (process.env.RESEND_API_KEY) return 'resend';
    if (this.transport) return 'smtp';
    return null;
  }

  get configured() {
    return !!this.provider;
  }

  private sender() {
    const email = process.env.MAIL_FROM_EMAIL || process.env.SMTP_USER || '';
    const name = process.env.MAIL_FROM_NAME || 'SAIF Chat';
    // SMTP_FROM may already be "Name <email>"
    const m = /^(.*)<([^>]+)>\s*$/.exec(process.env.SMTP_FROM || '');
    return m && !process.env.MAIL_FROM_EMAIL ? { name: m[1].trim() || name, email: m[2].trim() } : { name, email };
  }

  async send(to: string, subject: string, text: string, html: string) {
    const provider = this.provider;
    if (!provider) {
      this.log.warn(`Email is not set up, so this email was NOT sent. To: ${to}\nSubject: ${subject}\n${text}`);
      return;
    }
    const from = this.sender();
    if (!from.email && provider !== 'smtp') throw new Error('Set MAIL_FROM_EMAIL to the sender address you verified with your email provider');

    if (provider === 'brevo') {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': process.env.BREVO_API_KEY as string, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ sender: from, to: [{ email: to }], subject, htmlContent: html, textContent: text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        this.log.error(`Brevo ${res.status}: ${body}`);
        throw new Error(`Brevo could not send the email (${res.status})`);
      }
    } else if (provider === 'resend') {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: `${from.name} <${from.email}>`, to: [to], subject, html, text }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        const body = (await res.text()).slice(0, 300);
        this.log.error(`Resend ${res.status}: ${body}`);
        throw new Error(`Resend could not send the email (${res.status})`);
      }
    } else {
      await this.transport!.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text, html });
    }
    this.log.log(`Sent "${subject.replace(/\d{6}/, '******')}" to ${to} via ${provider}`);
  }
}

@Global()
@Module({ providers: [MailerService], exports: [MailerService] })
export class MailerModule {}
