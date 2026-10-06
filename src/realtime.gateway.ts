import { Global, Logger, Module } from '@nestjs/common';
import { OnGatewayConnection, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { PrismaService } from './prisma.service';
import { resolveUser } from './auth/auth.guard';

/**
 * Live updates. Each browser joins only its own workspace's room (from the session
 * cookie), so customers never receive each other's events.
 */
@WebSocketGateway({ namespace: '/realtime', cors: { origin: process.env.FRONTEND_URL || 'http://localhost:3100', credentials: true } })
export class RealtimeGateway implements OnGatewayConnection {
  private readonly log = new Logger('Realtime');
  @WebSocketServer() server!: Server;
  constructor(private prisma: PrismaService) {}

  async handleConnection(client: Socket) {
    try {
      const user = await resolveUser(this.prisma, client.handshake.headers.cookie);
      if (!user) return client.disconnect(true);
      if (user.workspaceId) client.join(`ws:${user.workspaceId}`);
      if (user.role === 'superadmin') client.join('admin');
    } catch (e) {
      this.log.warn(`Socket auth failed: ${(e as Error).message}`);
      client.disconnect(true);
    }
  }

  toWorkspace(workspaceId: string | null | undefined, event: string, data: unknown) {
    if (workspaceId) this.server?.to(`ws:${workspaceId}`).emit(event, data);
  }

  toAdmins(event: string, data: unknown) {
    this.server?.to('admin').emit(event, data);
  }
}

@Global()
@Module({ providers: [RealtimeGateway], exports: [RealtimeGateway] })
export class RealtimeModule {}
