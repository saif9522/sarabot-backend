import { Injectable, Logger, Module, OnApplicationBootstrap } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { hashPassword } from '../auth/crypto';

/**
 * First start:
 *  - creates the Super Admin from SUPERADMIN_EMAIL / SUPERADMIN_PASSWORD if none exists
 *  - moves data created before workspaces existed into a "Default workspace"
 */
@Injectable()
export class BootstrapService implements OnApplicationBootstrap {
  private readonly log = new Logger('Setup');
  constructor(private prisma: PrismaService) {}

  async onApplicationBootstrap() {
    if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
      this.log.warn('SESSION_SECRET is missing or short. Logins use a development key — set a long random SESSION_SECRET in .env before going live.');
    }
    if (!(await this.prisma.user.findFirst({ where: { role: 'superadmin' } }))) {
      const email = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();
      const password = process.env.SUPERADMIN_PASSWORD;
      if (!email || !password || password.length < 8) {
        this.log.warn('No Super Admin yet. Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD (8+ characters) in .env and restart.');
      } else {
        await this.prisma.user.create({ data: { email, name: 'Super Admin', role: 'superadmin', passwordHash: await hashPassword(password) } });
        this.log.log(`Super Admin created: ${email}. You can remove SUPERADMIN_PASSWORD from .env now.`);
      }
    }

    const orphans = (await Promise.all([
      this.prisma.account.count({ where: { workspaceId: null } }),
      this.prisma.bot.count({ where: { workspaceId: null } }),
      this.prisma.product.count({ where: { workspaceId: null } }),
      this.prisma.productCategory.count({ where: { workspaceId: null } }),
    ])).reduce((a, b) => a + b, 0);
    if (orphans) {
      const w = (await this.prisma.workspace.findFirst({ where: { name: 'Default workspace' } })) ?? (await this.prisma.workspace.create({ data: { name: 'Default workspace' } }));
      await this.prisma.$transaction([
        this.prisma.account.updateMany({ where: { workspaceId: null }, data: { workspaceId: w.id } }),
        this.prisma.bot.updateMany({ where: { workspaceId: null }, data: { workspaceId: w.id } }),
        this.prisma.product.updateMany({ where: { workspaceId: null }, data: { workspaceId: w.id } }),
        this.prisma.productCategory.updateMany({ where: { workspaceId: null }, data: { workspaceId: w.id } }),
      ]);
      this.log.log(`Moved earlier numbers, bots and products into "Default workspace". Add an owner login for it under Admin → Customers.`);
    }
  }
}

@Module({ providers: [BootstrapService] })
export class BootstrapModule {}
