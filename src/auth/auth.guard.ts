import { CanActivate, ExecutionContext, ForbiddenException, Injectable, SetMetadata, UnauthorizedException, createParamDecorator } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../prisma.service';
import { ACT_AS_COOKIE, SESSION_COOKIE, readCookie, verifyToken } from './crypto';

export type Role = 'superadmin' | 'owner' | 'admin' | 'agent';

/** Who is calling. `workspaceId` is the workspace being worked in (for a Super Admin: the one they opened). */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  /** Role used for permission checks inside a workspace (a Super Admin acting as a customer counts as owner) */
  effectiveRole: Role;
  workspaceId: string | null;
  seeUnassigned: boolean;
  actingAs: boolean;
}

export const IS_PUBLIC = 'isPublic';
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const ROLES = 'roles';
/** Allowed effective roles. A workspace is required unless 'superadmin' is listed. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);
export const ANY_USER = 'anyUser';
/** Any signed-in user, with or without a workspace (e.g. /auth/me). */
export const AnyUser = () => SetMetadata(ANY_USER, true);
export const CurrentUser = createParamDecorator((_d: unknown, ctx: ExecutionContext): AuthUser => ctx.switchToHttp().getRequest().user);

/** Resolve the user from the session cookie (or Authorization: Bearer). Shared with the websocket gateway. */
export async function resolveUser(prisma: PrismaService, cookieHeader?: string, authHeader?: string): Promise<AuthUser | null> {
  const token = readCookie(cookieHeader, SESSION_COOKIE) || (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined);
  const payload = verifyToken(token);
  if (!payload) return null;
  const u = await prisma.user.findUnique({ where: { id: payload.uid }, include: { workspace: { select: { status: true } } } });
  if (!u || !u.active || (payload.sv ?? 0) !== u.sessionVersion) return null;
  if (u.role !== 'superadmin' && (!u.workspaceId || u.workspace?.status !== 'active')) return null;

  let workspaceId = u.workspaceId;
  let effectiveRole = u.role as Role;
  let actingAs = false;
  if (u.role === 'superadmin') {
    const act = readCookie(cookieHeader, ACT_AS_COOKIE);
    if (act && (await prisma.workspace.findUnique({ where: { id: act }, select: { id: true } }))) {
      workspaceId = act;
      effectiveRole = 'owner';
      actingAs = true;
    }
  }
  return { id: u.id, name: u.name, email: u.email, role: u.role as Role, effectiveRole, workspaceId, seeUnassigned: u.seeUnassigned, actingAs };
}

/**
 * Global guard: every route needs a signed-in user unless marked @Public().
 * Routes without @Roles need a workspace (any role inside it).
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector, private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const targets = [ctx.getHandler(), ctx.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;
    const req = ctx.switchToHttp().getRequest();
    const user = await resolveUser(this.prisma, req.headers.cookie, req.headers.authorization);
    if (!user) throw new UnauthorizedException('Please sign in');
    req.user = user;

    if (this.reflector.getAllAndOverride<boolean>(ANY_USER, targets)) return true;

    const roles = this.reflector.getAllAndOverride<Role[]>(ROLES, targets) ?? [];
    if (roles.length) {
      const allowed = roles.includes(user.effectiveRole) || (roles.includes('superadmin') && user.role === 'superadmin');
      if (!allowed) throw new ForbiddenException('You do not have access to this');
      if (roles.every((r) => r === 'superadmin')) return true; // platform routes need no workspace
    }
    if (!user.workspaceId) throw new ForbiddenException('Open a customer workspace first');
    return true;
  }
}

/** Workspace id for the request; the guard guarantees it exists on workspace routes. */
export const ws = (u: AuthUser) => u.workspaceId as string;
