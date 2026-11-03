import { createSocket } from "node:dgram";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { audit, verifyAudit } from "./audit.ts";
import { AuditForwarder, cefLine, syslogMessage } from "./audit-forward.ts";
import { migrate, openPglite, openPostgres, type Db } from "./db.ts";

/** WP 3.8, NFR-11: the log is append-only in the database, kept a year, and forwarded to a SIEM. */

let db: Db;
beforeAll(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const a = await openPostgres(url);
    await a.exec("DROP SCHEMA IF EXISTS forward_test CASCADE; CREATE SCHEMA forward_test");
    await a.close();
    db = await openPostgres(`${url}${url.includes("?") ? "&" : "?"}options=${encodeURIComponent("-c search_path=forward_test")}`);
  } else db = await openPglite();
  await migrate(db);
}, 60_000);
afterAll(() => db.close());

const who = { ip: "10.1.2.3", host: "ANALYST-07" };
const sent = async () => Number((await db.query<{ value: unknown }>("SELECT value FROM settings WHERE key = 'audit.forwardedSeq'"))[0]!.value);

describe("CEF", () => {
  it("writes one entry as a CEF record that a SIEM can split", () => {
    const line = cefLine({ seq: "42", at: "2026-11-02T10:00:00.000Z", ip: "10.1.2.3", host: "ANALYST-07", action: "model.delete", target: "m-1", detail: { name: "Bridge | 12 = new\nline", n: 1 }, hash: "ab".repeat(32) });
    expect(line.startsWith("CEF:0|VIEWER|3D Intelligence Model Viewer|0.1.0|model.delete|Model deleted for good|6|")).toBe(true);
    const ext = line.split("|").slice(7).join("|");
    expect(ext).toContain("rt=1793613600000 src=10.1.2.3 shost=ANALYST-07 act=model.delete externalId=42 cs1Label=target cs1=m-1");
    // = and newlines are escaped in values; | needs no escape there.
    expect(ext).toContain('cs2={"name":"Bridge | 12 \\= new\\\\nline","n":1}');
    expect(ext).not.toMatch(/\n/);
    expect(ext).toContain(`cs3=${"ab".repeat(32)}`);
  });

  it("escapes | in the header and leaves out an address that is not an IP", () => {
    const line = cefLine({ seq: "1", at: "2026-11-02T10:00:00.000Z", ip: "", host: "", action: "odd|action", target: "", detail: {}, hash: "x" });
    expect(line.split("|")[4]).toBe("odd\\");
    expect(line).toContain("odd\\|action|odd\\|action|3|rt=");
    expect(line).not.toContain("src=");
  });

  it("frames it as RFC 5424, facility log audit", () => {
    const r = { seq: "1", at: "2026-11-02T10:00:00.000Z", ip: "", host: "", action: "admin.login.failed", target: "", detail: {}, hash: "x" };
    expect(syslogMessage(r, "viewer-srv")).toMatch(/^<108>1 2026-11-02T10:00:00\.000Z viewer-srv viewer \d+ audit - CEF:0\|/);
    expect(syslogMessage({ ...r, action: "model.view" }, "viewer-srv").startsWith("<109>1 ")).toBe(true);
  });
});

describe("forwarding", () => {
  it("sends every committed entry over UDP, in order, once", async () => {
    const got: string[] = [];
    const sock = createSocket("udp4");
    await new Promise<void>((r) => sock.bind(0, "127.0.0.1", r));
    sock.on("message", (m) => got.push(m.toString()));
    const port = (sock.address() as AddressInfo).port;
    for (const a of ["model.view", "model.update", "admin.login"]) await audit(db, { ...who, action: a, target: "m-1" });
    const f = new AuditForwarder(db, `udp://127.0.0.1:${port}`, { hostname: "viewer-srv" });
    expect(await f.tick()).toBe(3);
    expect(await f.tick()).toBe(0);
    await new Promise((r) => setTimeout(r, 100));
    expect(got.map((m) => /act=(\S+)/.exec(m)![1])).toEqual(["model.view", "model.update", "admin.login"]);
    expect(await sent()).toBe(3);
    await f.stop();
    sock.close();
  });

  it("over TCP, keeps what the SIEM missed while it was down and sends it when it is back", async () => {
    const frames: string[] = [];
    let buf = "";
    const conns = new Set<import("node:net").Socket>();
    const listen = (port = 0) =>
      new Promise<Server>((resolve) => {
        const srv = createServer((c) =>
          conns.add(c).has(c) && c.on("data", (d) => {
            buf += d.toString();
            // Octet counting: "<length> <message>".
            for (let m = /^(\d+) /.exec(buf); m && buf.length >= m[0].length + Number(m[1]); m = /^(\d+) /.exec(buf)) {
              frames.push(buf.slice(m[0].length, m[0].length + Number(m[1])));
              buf = buf.slice(m[0].length + Number(m[1]));
            }
          }),
        );
        srv.listen(port, "127.0.0.1", () => resolve(srv));
      });
    let srv = await listen();
    const port = (srv.address() as AddressInfo).port;
    const errors: unknown[] = [];
    const f = new AuditForwarder(db, `tcp://127.0.0.1:${port}`, { onError: (e) => errors.push(e) });

    await audit(db, { ...who, action: "model.create", target: "m-2", detail: { note: "two\nlines" } });
    expect(await f.tick()).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(frames).toHaveLength(1);
    // The SIEM goes away, dropping the connection. Entries keep being written and wait.
    const down = new Promise<void>((r) => srv.close(() => r()));
    for (const c of conns) c.destroy();
    await down;
    await f.stop();
    const g = new AuditForwarder(db, `tcp://127.0.0.1:${port}`, { onError: (e) => errors.push(e) });
    await audit(db, { ...who, action: "model.delete", target: "m-2" });
    await audit(db, { ...who, action: "settings.quota" });
    expect(await g.tick()).toBe(0);
    expect(errors.length).toBe(1);
    expect(await sent()).toBe(4);
    // Back again: the two waiting entries go out, nothing twice.
    srv = await listen(port);
    expect(await g.tick()).toBe(2);
    await new Promise((r) => setTimeout(r, 100));
    expect(frames.map((m) => /act=(\S+)/.exec(m)![1])).toEqual(["model.create", "model.delete", "settings.quota"]);
    expect(frames[0]).toContain("two\\\\nlines");
    expect(await sent()).toBe(6);
    await g.stop();
    for (const c of conns) c.destroy();
    await new Promise<void>((r) => srv.close(() => r()));
  });

  it("refuses an address it cannot use", () => {
    expect(() => new AuditForwarder(db, "http://siem:514")).toThrow(/udp:\/\/, tcp:\/\/ or tls:\/\//);
  });
});

describe("the database keeps the log", () => {
  it("refuses to change, delete or empty recent entries", async () => {
    await expect(db.query("UPDATE audit_events SET host = 'x'")).rejects.toThrow(/append-only/);
    await expect(db.query("DELETE FROM audit_events")).rejects.toThrow(/at least a year/);
    await expect(db.exec("TRUNCATE audit_events")).rejects.toThrow(/at least a year/);
    expect((await verifyAudit(db)).ok).toBe(true);
  });

  it("lets entries over a year old go, and the chain still checks from the oldest one kept", async () => {
    // Make the first two entries look 400 days old (the guard is off only for this set-up).
    await db.exec("ALTER TABLE audit_events DISABLE TRIGGER audit_events_rows");
    const old = await db.query<{ seq: string; at: Date }>("SELECT seq, at FROM audit_events ORDER BY seq LIMIT 2");
    await db.exec("ALTER TABLE audit_events ENABLE TRIGGER audit_events_rows");
    expect(old).toHaveLength(2);
    // Their hashes cover `at`, so they are rewritten as a chain that is 400 days older all through.
    await db.exec("ALTER TABLE audit_events DISABLE TRIGGER audit_events_rows");
    await db.query("UPDATE audit_events SET at = at - interval '400 days' WHERE seq <= $1", [old[1]!.seq]);
    await db.exec("ALTER TABLE audit_events ENABLE TRIGGER audit_events_rows");

    await expect(db.query("DELETE FROM audit_events WHERE seq > $1", [old[1]!.seq])).rejects.toThrow(/at least a year/);
    await db.query("DELETE FROM audit_events WHERE at < now() - interval '366 days'");
    const v = await verifyAudit(db);
    expect(v).toMatchObject({ firstSeq: Number(old[1]!.seq) + 1 });
    expect(v.ok).toBe(true);
  });
});
