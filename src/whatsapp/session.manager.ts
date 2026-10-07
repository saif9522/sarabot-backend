import { Global, Injectable, Logger, Module, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import makeWASocket, {
  Browsers, DisconnectReason, WASocket, fetchLatestBaileysVersion, normalizeMessageContent, 
} from '@whiskeysockets/baileys';
import pino from 'pino';
import * as QRCode from 'qrcode';
import { promises as fs } from 'fs';
import * as path from 'path';
import { PrismaService } from '../prisma.service';
import { RealtimeGateway } from '../realtime.gateway';
import { MIME_BY_EXT, localMediaPath, writableDir } from '../media';
import { clearDbAuth, importFileAuth, linkedAccountIds, useDbAuthState } from './db-auth-state';

export type SessionStatus = 'disconnected' | 'starting' | 'qr' | 'connected';
export interface SessionState { status: SessionStatus; qr: string | null; lastError: string | null }
export interface Inbound { accountId: string; workspaceId: string | null; from: string; name?: string; text: string; id: string }

const ROOT = writableDir(process.env.SESSION_DIR, './wa-sessions');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export const toWaId = (jid: string) => (jid.endsWith('@s.whatsapp.net') ? jid.split('@')[0].split(':')[0] : jid);
export const toJid = (waId: string) => (waId.includes('@') ? waId : `${waId.replace(/\D/g, '')}@s.whatsapp.net`);

interface Session { sock?: WASocket; state: SessionState; stopping: boolean }

/** Give up after this many silent reconnects in a row and tell the user. */
const MAX_RETRIES = 4;
/** If no QR and no connection after this long, report it instead of spinning forever. */
const START_TIMEOUT_MS = 60_000;

/**
 * How long "typing…" shows before a text reply: TYPING_MIN_MS + TYPING_MS_PER_CHAR per character, capped at TYPING_MAX_MS.
 * Defaults (700 / 25 / 4000) look human. Set TYPING_MAX_MS=0 to reply with no typing pause at all.
 */
const num = (v: string | undefined, d: number) => (v !== undefined && v !== '' && !Number.isNaN(Number(v)) ? Math.max(0, Number(v)) : d);
const TYPING_MIN_MS = num(process.env.TYPING_MIN_MS, 700);
const TYPING_MS_PER_CHAR = num(process.env.TYPING_MS_PER_CHAR, 25);
const TYPING_MAX_MS = num(process.env.TYPING_MAX_MS, 4000);
const MEDIA_DELAY_MS = num(process.env.MEDIA_DELAY_MS, 800);

/**
 * One WhatsApp Web connection per linked number (QR scan, like web.whatsapp.com).
 * Sessions are saved per number and reconnect automatically on startup.
 * Unofficial protocol: the bot only answers people who message first, ignores groups,
 * broadcasts, channels and history, and shows "typing…" briefly before each reply.
 */
@Injectable()
export class SessionManager implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('WhatsApp');
  private sessions = new Map<string, Session>();
  /** accountId -> workspaceId, for routing live updates */
  private owners = new Map<string, string | null>();
  private handler?: (m: Inbound) => Promise<void>;
  /** accountId -> failed reconnects in a row */
  private retries = new Map<string, number>();
  /** accountIds whose connection is being opened right now (prevents two sockets at once) */
  private opening = new Set<string>();

  constructor(private prisma: PrismaService, private rt: RealtimeGateway) {}

  onMessage(fn: (m: Inbound) => Promise<void>) {
    this.handler = fn;
  }

  state(accountId: string): SessionState {
    return this.sessions.get(accountId)?.state ?? { status: 'disconnected', qr: null, lastError: null };
  }

  isConnected(accountId: string) {
    const s = this.sessions.get(accountId);
    return !!s?.sock && s.state.status === 'connected';
  }

  private dir(accountId: string) {
    return path.join(ROOT, accountId.replace(/[^\w-]/g, ''));
  }

  private watchdog?: NodeJS.Timeout;
  private keepAlive?: NodeJS.Timeout;

  async onApplicationBootstrap() {
    const accounts = await this.prisma.account.findMany({ select: { id: true } });
    for (const a of accounts) {
      try { await importFileAuth(this.prisma, a.id, this.dir(a.id)); } catch { /* no old files */ }
    }
    for (const id of await linkedAccountIds(this.prisma)) {
      this.start(id).catch((e) => this.log.error(`${id}: auto-connect failed: ${e.message}`));
    }
    // Every minute: any number that is linked but not connected gets reconnected.
    // A number is only left alone after Unlink (or logout from the phone), which deletes its login.
    this.watchdog = setInterval(() => this.reviveAll().catch((e) => this.log.error(`Watchdog: ${e.message}`)), 60_000);
    this.startKeepAlive();
  }

  private async reviveAll() {
    for (const accountId of await linkedAccountIds(this.prisma)) {
      const s = this.sessions.get(accountId);
      const down = !s || (!s.sock && s.state.status !== 'qr') || s.state.status === 'disconnected';
      if (down && !this.opening.has(accountId)) {
        this.log.log(`Watchdog: reconnecting ${accountId}`);
        if (s) s.state.status = 'disconnected';
        this.start(accountId).catch((e) => this.log.error(`Watchdog ${accountId}: ${e.message}`));
      }
    }
  }

  /**
   * Render's free plan sleeps after 15 minutes without web traffic, which drops WhatsApp.
   * When running on Render, ping our own public URL every 10 minutes so it stays awake.
   * Turn off with KEEP_ALIVE=false (not needed on a paid plan).
   */
  private startKeepAlive() {
    const base = (process.env.KEEP_ALIVE_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
    if (!base || process.env.KEEP_ALIVE === 'false') return;
    const url = `${base}/api/health`;
    this.log.log(`Keep-alive: pinging ${url} every 10 minutes`);
    this.keepAlive = setInterval(() => {
      fetch(url, { signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
    }, 10 * 60_000);
  }

  async onModuleDestroy() {
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.keepAlive) clearInterval(this.keepAlive);
    for (const s of this.sessions.values()) {
      s.stopping = true;
      s.sock?.end(undefined);
    }
  }

  /** Changes the state of the current session. With `only`, does nothing if that session has been replaced. */
  private update(accountId: string, patch: Partial<SessionState>, only?: Session) {
    const s = this.sessions.get(accountId);
    if (!s || (only && s !== only)) return;
    s.state = { ...s.state, ...patch };
    this.rt.toWorkspace(this.owners.get(accountId), 'account', { id: accountId, ...s.state });
  }

  async start(accountId: string): Promise<SessionState> {
    const existing = this.sessions.get(accountId);
    if (existing?.sock && existing.state.status !== 'disconnected') return existing.state;
    if (this.opening.has(accountId)) return this.state(accountId);
    // Close any leftover socket first: two live sockets for one number fight each other.
    if (existing?.sock) {
      existing.stopping = true;
      try { existing.sock.end(undefined); } catch { /* already closed */ }
      existing.sock = undefined;
    }
    const acc = await this.prisma.account.findUnique({ where: { id: accountId }, select: { workspaceId: true } });
    if (!acc) throw new Error('Number not found');
    this.owners.set(accountId, acc.workspaceId);
    this.sessions.set(accountId, { sock: undefined, stopping: false, state: { status: 'starting', qr: null, lastError: null } });
    this.update(accountId, {});
    const mine = this.sessions.get(accountId)!;
    this.opening.add(accountId);
    try {
      await this.open(accountId);
    } catch (e: any) {
      this.log.error(`Could not start WhatsApp for ${accountId}: ${e?.message ?? e}`);
      this.update(accountId, { status: 'disconnected', qr: null, lastError: `Could not start WhatsApp: ${e?.message ?? 'unknown error'}. Click Link to try again.` }, mine);
    } finally {
      this.opening.delete(accountId);
    }
    // Never spin forever: report if there is still no QR or connection after a minute.
    setTimeout(() => {
      const s = this.sessions.get(accountId);
      if (s && s === mine && s.state.status === 'starting' && !s.stopping) {
        this.log.warn(`No QR from WhatsApp for ${accountId} after ${START_TIMEOUT_MS / 1000}s`);
        s.stopping = true;
        s.sock?.end(undefined);
        this.update(accountId, { status: 'disconnected', qr: null, lastError: 'WhatsApp did not send a QR code. Click Link to try again.' }, mine);
      }
    }, START_TIMEOUT_MS);
    return this.state(accountId);
  }

  private async open(accountId: string) {
    const { state, saveCreds } = await useDbAuthState(this.prisma, accountId);
    let version: [number, number, number] | undefined;
    try {
      version = (await fetchLatestBaileysVersion()).version;
    } catch {
      /* fall back to the library's built-in version */
    }
    const sock = makeWASocket({
      auth: state,
      ...(version ? { version } : {}),
      browser: Browsers.windows('Sarabot'),
      logger: pino({ level: 'silent' }) as any,
      markOnlineOnConnect: false,
      syncFullHistory: false,
    });
    const session = this.sessions.get(accountId)!;
    session.sock = sock;
    /** False once a newer connection replaced this one: then this socket must not touch anything. */
    const live = () => this.sessions.get(accountId) === session && !session.stopping;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (u) => {
      if (!live() && u.connection !== 'close') {
        // An old socket still talking: shut it, it must not change the current state.
        try { sock.end(undefined); } catch { /* already closed */ }
        return;
      }
      if (u.qr) this.update(accountId, { status: 'qr', qr: await QRCode.toDataURL(u.qr, { margin: 1, width: 320 }) }, session);
      if (u.connection === 'open') {
        this.retries.delete(accountId);
        const phone = sock.user?.id ? toWaId(sock.user.id) : null;
        this.update(accountId, { status: 'connected', qr: null, lastError: null }, session);
        if (phone) await this.prisma.account.update({ where: { id: accountId }, data: { phone } }).catch(() => undefined);
        this.rt.toWorkspace(this.owners.get(accountId), 'account', { id: accountId, ...session.state, phone });
        this.log.log(`Connected +${phone}`);
      }
      if (u.connection === 'close') {
        if (this.sessions.get(accountId) !== session) {
          this.log.log(`Old connection for ${accountId} closed (already replaced)`);
          return;
        }
        const code = (u.lastDisconnect?.error as any)?.output?.statusCode as number | undefined;
        const reason = (u.lastDisconnect?.error as any)?.message as string | undefined;
        const waitingForScan = session.state.status === 'qr';
        session.sock = undefined;
        this.log.warn(`Connection closed for ${accountId}: code ${code ?? '-'} ${reason ?? ''}`);
        const linked = !!state.creds?.registered;
        const tries = (this.retries.get(accountId) ?? 0) + 1;
        if (code === DisconnectReason.loggedOut) {
          await clearDbAuth(this.prisma, accountId);
          await fs.rm(this.dir(accountId), { recursive: true, force: true }).catch(() => undefined);
          this.update(accountId, { status: 'disconnected', qr: null, lastError: 'Logged out from the phone. Link it again with a new QR code.' }, session);
        } else if (session.stopping) {
          this.update(accountId, { status: 'disconnected', qr: null }, session);
        } else if (waitingForScan && code !== DisconnectReason.restartRequired) {
          this.update(accountId, { status: 'disconnected', qr: null, lastError: 'The QR code expired. Click Link to get a new one.' }, session);
        } else if (tries > MAX_RETRIES && !linked) {
          this.retries.delete(accountId);
          // A half-finished link (never scanned) can leave bad keys behind; start clean next time.
          await clearDbAuth(this.prisma, accountId).catch(() => undefined);
          this.update(accountId, {
            status: 'disconnected', qr: null,
            lastError: `WhatsApp closed the connection (code ${code ?? 'unknown'}). Click Link to try again.`,
          }, session);
        } else {
          // Linked numbers keep retrying forever: 3 s, 6 s, 9 s … up to every 5 minutes.
          this.retries.set(accountId, tries);
          this.update(accountId, { status: 'starting', lastError: tries > 2 ? `Reconnecting to WhatsApp (attempt ${tries})…` : null }, session);
          setTimeout(() => {
            if (this.sessions.get(accountId) !== session) return; // something else already reconnected
            session.state.status = 'disconnected'; // let start() run again
            this.start(accountId).catch((e) => this.log.error(e.message));
          }, Math.min(3000 * tries, 5 * 60_000));
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' || !live()) return; // an old socket must not answer twice
      for (const m of messages) {
        try {
          const jid = m.key.remoteJid;
          if (!jid || m.key.fromMe || !m.message) continue;
          if (jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;
          const c = normalizeMessageContent(m.message);
          if (!c || c.protocolMessage || c.reactionMessage || c.senderKeyDistributionMessage) continue;
          const text =
            c.conversation || c.extendedTextMessage?.text || c.imageMessage?.caption || c.videoMessage?.caption ||
            c.buttonsResponseMessage?.selectedDisplayText || c.listResponseMessage?.title ||
            `[${Object.keys(c)[0]?.replace('Message', '') || 'media'} message]`;
          await this.handler?.({ accountId, workspaceId: this.owners.get(accountId) ?? null, from: toWaId(jid), name: m.pushName || undefined, text, id: m.key.id! });
        } catch (e) {
          this.log.error(`Inbound message failed: ${(e as Error).message}`);
        }
      }
    });

    return session.state;
  }

  /** `typing: false` sends at once (replies typed by a person in the dashboard); bot replies show "typing…" first. */
  async sendText(accountId: string, to: string, text: string, opts: { typing?: boolean } = {}): Promise<string | undefined> {
    const s = this.sessions.get(accountId);
    if (!s?.sock || s.state.status !== 'connected') throw new Error('This number is not connected');
    const jid = toJid(to);
    const typing = opts.typing !== false && TYPING_MAX_MS > 0;
    if (typing) {
      await s.sock.sendPresenceUpdate('composing', jid).catch(() => undefined);
      await sleep(Math.min(TYPING_MAX_MS, TYPING_MIN_MS + text.length * TYPING_MS_PER_CHAR));
    }
    const res = await s.sock.sendMessage(jid, { text });
    if (typing) await s.sock.sendPresenceUpdate('paused', jid).catch(() => undefined);
    return res?.key?.id ?? undefined;
  }

  /** Send an image or document: an uploaded file or an https:// link. */
  async sendMedia(accountId: string, to: string, m: { type: 'image' | 'document'; media: string; caption?: string; fileName?: string }) {
    const s = this.sessions.get(accountId);
    if (!s?.sock || s.state.status !== 'connected') throw new Error('This number is not connected');
    const local = localMediaPath(m.media);
    const source = local ? await fs.readFile(local) : { url: m.media };
    const jid = toJid(to);
    await sleep(MEDIA_DELAY_MS);
    const res =
      m.type === 'image'
        ? await s.sock.sendMessage(jid, { image: source, caption: m.caption })
        : await s.sock.sendMessage(jid, {
            document: source,
            caption: m.caption,
            fileName: m.fileName || path.basename(m.media),
            mimetype: MIME_BY_EXT[path.extname(m.media).toLowerCase()] || 'application/octet-stream',
          });
    return res?.key?.id ?? undefined;
  }

  async markRead(accountId: string, from: string, id: string) {
    const s = this.sessions.get(accountId);
    if (s?.sock && s.state.status === 'connected') await s.sock.readMessages([{ remoteJid: toJid(from), id, fromMe: false }]).catch(() => undefined);
  }

  async logout(accountId: string) {
    const s = this.sessions.get(accountId);
    if (s) {
      s.stopping = true;
      try {
        await s.sock?.logout();
      } catch {
        /* already closed */
      }
      s.sock = undefined;
    }
    await clearDbAuth(this.prisma, accountId);
    await fs.rm(this.dir(accountId), { recursive: true, force: true }).catch(() => undefined);
    this.sessions.set(accountId, { sock: undefined, stopping: true, state: { status: 'disconnected', qr: null, lastError: null } });
    this.rt.toWorkspace(this.owners.get(accountId), 'account', { id: accountId, status: 'disconnected', qr: null, lastError: null });
  }

  forget(accountId: string) {
    this.sessions.delete(accountId);
    this.owners.delete(accountId);
  }
}

@Global()
@Module({ providers: [SessionManager], exports: [SessionManager] })
export class SessionModule {}
