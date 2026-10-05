import { Global, Injectable, Logger, Module } from '@nestjs/common';
import * as nodemailer from 'nodemailer';

/**
 * Sends email over SMTP (Gmail, Zoho, Brevo, any provider). Without SMTP settings the
 * message is printed in the backend terminal instead, so password resets still work locally.
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
      })
    : null;

  get configured() {
    return !!this.transport;
  }

  async send(to: string, subject: string, text: string, html: string) {
    if (!this.transport) {
      this.log.warn(`SMTP is not set up, so this email was NOT sent. To: ${to}\nSubject: ${subject}\n${text}`);
      return;
    }
    await this.transport.sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text, html });
  }
}

@Global()
@Module({ providers: [MailerService], exports: [MailerService] })
export class MailerModule {}
