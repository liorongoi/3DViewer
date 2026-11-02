import { createSocket, type Socket as UdpSocket } from "node:dgram";
import { isIP, connect as tcpConnect, type Socket } from "node:net";
import { hostname as osHostname } from "node:os";
import { connect as tlsConnect } from "node:tls";
import type { AuditRow } from "./audit.ts";
import type { Db } from "./db.ts";

/**
 * Sends the audit log to the site's SIEM (WP 3.8, NFR-11) as CEF in syslog (RFC 5424).
 *
 * It reads the table rather than hooking the writers, so an entry is sent only once its
 * transaction has committed, in order, and nothing is lost while the SIEM is down or the
 * server restarts: the last delivered sequence number is kept in settings. Delivery is at
 * least once; the SIEM can drop repeats by `externalId`, the entry's sequence number.
 *
 *   AUDIT_SYSLOG=udp://siem:514 | tcp://siem:514 | tls://siem:6514
 */

const VERSION = "0.1.0";

const header = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|");
const ext = (s: string) => s.replace(/\\/g, "\\\\").replace(/=/g, "\\=").replace(/\r?\n/g, "\\n");

/** How much a SIEM should care, 0–10. */
export function cefSeverity(action: string): number {
  if (action === "admin.login.failed") return 7;
  if (action === "model.delete" || action === "classification.delete" || action.startsWith("admin.password")) return 6;
  if (action.startsWith("settings.") || action.startsWith("classification.") || action === "admin.login" || action === "audit.export") return 5;
  if (action === "ingest.reject") return 4;
  return 3;
}

const NAMES: Record<string, string> = {
  "model.view": "Model opened",
  "model.create": "Model published",
  "model.update": "Model details changed",
  "model.delete": "Model deleted for good",
  "version.create": "New version published",
  "ingest.create": "Upload started",
  "ingest.reject": "Upload rejected",
  "audit.export": "Audit log exported",
  "admin.login": "Admin signed in",
  "admin.login.failed": "Wrong admin password",
  "admin.logout": "Admin signed out",
  "admin.password.change": "Admin password changed",
  "admin.password.set": "Admin password set",
  "admin.password.reset": "Admin password reset",
  "classification.create": "Classification level added",
  "classification.update": "Classification level changed",
  "classification.delete": "Classification level removed",
  "settings.quota": "Storage quota changed",
  "settings.basemaps": "Base map sources changed",
  "system.seed": "First start",
};

/** One audit entry as a CEF record. */
export function cefLine(r: Pick<AuditRow, "seq" | "at" | "ip" | "host" | "action" | "target" | "detail" | "hash">): string {
  const detail = JSON.stringify(r.detail ?? {});
  const fields: [string, string | number][] = [
    ["rt", new Date(r.at).getTime()],
    ...(isIP(r.ip) ? ([["src", r.ip]] as [string, string][]) : []),
    ...(r.host ? ([["shost", r.host]] as [string, string][]) : []),
    ["act", r.action],
    ["externalId", String(r.seq)],
    ["cs1Label", "target"],
    ["cs1", r.target],
    ["cs2Label", "detail"],
    // SIEMs commonly cap a custom string at 4000 characters.
    ["cs2", detail.length > 4000 ? `${detail.slice(0, 3990)}…` : detail],
    ["cs3Label", "hash"],
    ["cs3", r.hash],
  ];
  return [
    "CEF:0",
    "VIEWER",
    "3D Intelligence Model Viewer",
    VERSION,
    header(r.action),
    header(NAMES[r.action] ?? r.action),
    String(cefSeverity(r.action)),
    fields.map(([k, v]) => `${k}=${ext(String(v))}`).join(" "),
  ].join("|");
}

/** RFC 5424 frame: facility 13 (log audit); severity warning for a failed sign-in, notice otherwise. */
export function syslogMessage(r: Parameters<typeof cefLine>[0], host = osHostname()): string {
  const sev = r.action === "admin.login.failed" ? 4 : 5;
  const ts = new Date(r.at).toISOString();
  const h = (host || "-").replace(/\s/g, "").slice(0, 255);
  return `<${13 * 8 + sev}>1 ${ts} ${h} viewer ${process.pid} audit - ${cefLine(r)}`;
}

interface Transport {
  send(msg: string): Promise<void>;
  close(): void;
}

function udp(host: string, port: number): Transport {
  let sock: UdpSocket | null = null;
  return {
    send: (msg) =>
      new Promise((resolve, reject) => {
        sock ??= createSocket(isIP(host) === 6 ? "udp6" : "udp4");
        sock.send(Buffer.from(msg), port, host, (e) => (e ? reject(e) : resolve()));
      }),
    close: () => {
      sock?.close();
      sock = null;
    },
  };
}

/** TCP or TLS with octet counting (RFC 6587), so a detail with a newline stays one message. */
function stream(host: string, port: number, tls: boolean): Transport {
  let sock: Socket | null = null;
  const open = () =>
    new Promise<Socket>((resolve, reject) => {
      const s = tls ? tlsConnect({ host, port, servername: isIP(host) ? undefined : host }) : tcpConnect({ host, port });
      const fail = (e: Error) => {
        s.destroy();
        reject(e);
      };
      s.once("error", fail);
      s.once(tls ? "secureConnect" : "connect", () => {
        s.off("error", fail);
        s.on("error", () => {
          s.destroy();
          if (sock === s) sock = null;
        });
        s.on("close", () => {
          if (sock === s) sock = null;
        });
        s.setKeepAlive(true, 30_000);
        resolve(s);
      });
      s.setTimeout(10_000, () => fail(new Error(`No answer from ${host}:${port}.`)));
    });
  return {
    async send(msg) {
      sock ??= await open();
      sock.setTimeout(0);
      const body = Buffer.from(msg);
      const s = sock;
      await new Promise<void>((resolve, reject) => s.write(Buffer.concat([Buffer.from(`${body.length} `), body]), (e) => (e ? reject(e) : resolve())));
    },
    close: () => {
      sock?.end();
      sock = null;
    },
  };
}

export function transportFor(target: string): Transport {
  const u = new URL(target);
  const port = Number(u.port) || (u.protocol === "tls:" ? 6514 : 514);
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (u.protocol === "udp:") return udp(host, port);
  if (u.protocol === "tcp:" || u.protocol === "tls:") return stream(host, port, u.protocol === "tls:");
  throw new Error(`AUDIT_SYSLOG must start with udp://, tcp:// or tls://, not ${u.protocol}`);
}

export class AuditForwarder {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<number> | null = null;
  private readonly transport: Transport;
  /** The last error, for the log; cleared by a successful send. */
  lastError: string | null = null;

  constructor(
    private db: Db,
    target: string,
    private opts: { intervalMs?: number; batch?: number; hostname?: string; onError?: (e: unknown) => void } = {},
  ) {
    this.transport = transportFor(target);
  }

  /** Sends what is new. Returns how many entries went out. */
  tick(): Promise<number> {
    this.running ??= this.sendNew().finally(() => (this.running = null));
    return this.running;
  }

  private async sendNew(): Promise<number> {
    const [c] = await this.db.query<{ value: number | string }>("SELECT value FROM settings WHERE key = 'audit.forwardedSeq'");
    let cursor = Number(c?.value ?? 0);
    const rows = await this.db.query<AuditRow>("SELECT * FROM audit_events WHERE seq > $1 ORDER BY seq LIMIT $2", [cursor, this.opts.batch ?? 500]);
    let sent = 0;
    try {
      for (const r of rows) {
        await this.transport.send(syslogMessage({ ...r, at: new Date(r.at).toISOString() }, this.opts.hostname));
        cursor = Number(r.seq);
        sent++;
      }
      this.lastError = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg !== this.lastError) this.opts.onError?.(e);
      this.lastError = msg;
    }
    if (sent) await this.db.query("INSERT INTO settings (key, value) VALUES ('audit.forwardedSeq', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(cursor)]);
    // A full batch means more is waiting: carry on at once.
    if (sent === (this.opts.batch ?? 500)) return sent + (await this.sendNew());
    return sent;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((e) => this.opts.onError?.(e)), this.opts.intervalMs ?? 2000);
    void this.tick().catch((e) => this.opts.onError?.(e));
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running?.catch(() => undefined);
    this.transport.close();
  }
}
