import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma.service';
import { RealtimeModule } from './realtime.gateway';
import { LlmModule } from './llm.service';
import { BotModule } from './bot/bot.engine';
import { SessionModule } from './whatsapp/session.manager';
import { InboundModule } from './whatsapp/inbound.service';
import { AccountsController } from './api/accounts.controller';
import { BotsController } from './api/bots.controller';
import { ChatsController } from './api/chats.controller';
import { ProductsController } from './api/products.controller';
import { DashboardController } from './api/dashboard.controller';
import { UploadsController } from './api/uploads.controller';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard } from './auth/auth.guard';
import { AuthController } from './auth/auth.controller';
import { SubscriptionModule } from './billing/subscription.service';
import { BootstrapModule } from './billing/bootstrap.service';
import { MailerModule } from './auth/mailer.service';
import { AdminController } from './api/admin.controller';
import { AgentsController } from './api/agents.controller';
import { BillingController } from './api/billing.controller';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, RealtimeModule, LlmModule, SubscriptionModule, BootstrapModule, MailerModule, BotModule, SessionModule, InboundModule],
  controllers: [AuthController, AdminController, AgentsController, BillingController, AccountsController, BotsController, ChatsController, ProductsController, DashboardController, UploadsController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
