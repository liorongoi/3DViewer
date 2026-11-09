import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { proxyServer } from "./server-proxy";

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.url === "/api/redirect-in") return res.writeHead(302, { location: `${base}/api/models?x=1` }).end();
      if (req.url === "/api/redirect-out") return res.writeHead(302, { location: "https://elsewhere.example/" }).end();
      res.writeHead(200, { "content-type": "application/json", "set-cookie": "a=b", "x-kept": "yes" });
      res.end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString(), auth: req.headers.authorization ?? null, range: req.headers.range ?? null, cookie: req.headers.cookie ?? null }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

const go = (url: string, init?: RequestInit) => proxyServer(base, new Request(url, init), (u, i) => fetch(u, i as RequestInit));

describe("viewer-server", () => {
  it("forwards the path, query and headers", async () => {
    const r = await go("viewer-server://library/api/models?page=2", { headers: { authorization: "Bearer t", range: "bytes=0-3", cookie: "no" } });
    expect(r.status).toBe(200);
    expect(r.headers.get("x-kept")).toBe("yes");
    expect(r.headers.get("set-cookie")).toBeNull();
    expect(await r.json()).toMatchObject({ method: "GET", url: "/api/models?page=2", auth: "Bearer t", range: "bytes=0-3", cookie: null });
  });
  it("forwards a body", async () => {
    const r = await go("viewer-server://library/api/x", { method: "PATCH", body: '{"a":1}', headers: { "content-type": "application/json" } });
    expect(await r.json()).toMatchObject({ method: "PATCH", body: '{"a":1}' });
  });
  it("keeps redirects on the server and drops the others", async () => {
    const a = await go("viewer-server://library/api/redirect-in");
    expect(a.status).toBe(302);
    expect(a.headers.get("location")).toBe("viewer-server://library/api/models?x=1");
    const b = await go("viewer-server://library/api/redirect-out");
    expect(b.headers.get("location")).toBeNull();
  });
  it("answers 404 for another host and 502 when the server is down", async () => {
    expect((await go("viewer-server://other/api")).status).toBe(404);
    const down = await proxyServer("http://127.0.0.1:1", new Request("viewer-server://library/api/health"), (u, i) => fetch(u, i as RequestInit));
    expect(down.status).toBe(502);
  });
});

describe("cross-origin checks", () => {
  it("answers a preflight itself", async () => {
    const r = await go("viewer-server://library/api/models/x", { method: "OPTIONS", headers: { "access-control-request-method": "PATCH", "access-control-request-headers": "authorization, content-type" } });
    expect(r.status).toBe(204);
    expect(r.headers.get("access-control-allow-origin")).toBe("viewer-app://app");
    expect(r.headers.get("access-control-allow-headers")).toBe("authorization, content-type");
    expect(r.headers.get("access-control-allow-methods")).toContain("PATCH");
  });
  it("lets the page read the answer and its headers", async () => {
    const r = await go("viewer-server://library/api/models");
    expect(r.headers.get("access-control-allow-origin")).toBe("viewer-app://app");
    expect(r.headers.get("access-control-expose-headers")).toContain("x-kept");
  });
});
