import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Roots, parseRange, serveLocal } from "./local-files";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vf-"));
fs.mkdirSync(path.join(dir, "set", "tiles"), { recursive: true });
fs.writeFileSync(path.join(dir, "set", "tileset.json"), '{"asset":{"version":"1.1"}}');
fs.writeFileSync(path.join(dir, "set", "tiles", "0 1.b3dm"), Buffer.from("0123456789"));
fs.writeFileSync(path.join(dir, "secret.txt"), "no");
fs.symlinkSync(path.join(dir, "secret.txt"), path.join(dir, "set", "link.txt"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

const roots = new Roots();
const id = roots.add(path.join(dir, "set"));
const get = (p: string, range?: string) => serveLocal(roots, new Request(`viewer-file://${id}/${p}`, { headers: range ? { range } : {} }));

describe("range header", () => {
  it("parses the three forms", () => {
    expect(parseRange("bytes=0-3", 10)).toEqual({ start: 0, end: 3 });
    expect(parseRange("bytes=4-", 10)).toEqual({ start: 4, end: 9 });
    expect(parseRange("bytes=-3", 10)).toEqual({ start: 7, end: 9 });
    expect(parseRange("bytes=2-99", 10)).toEqual({ start: 2, end: 9 });
    expect(parseRange(null, 10)).toBeNull();
  });
  it("rejects impossible ranges", () => {
    expect(parseRange("bytes=10-", 10)).toBe("invalid");
    expect(parseRange("bytes=5-2", 10)).toBe("invalid");
    expect(parseRange("items=0-1", 10)).toBe("invalid");
  });
});

describe("viewer-file", () => {
  it("serves a whole file with its type", async () => {
    const r = await get("tileset.json");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/json");
    expect(await r.json()).toEqual({ asset: { version: "1.1" } });
  });
  it("serves a byte range of a file with a space in its name", async () => {
    const r = await get("tiles/0%201.b3dm", "bytes=2-5");
    expect(r.status).toBe(206);
    expect(r.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await r.text()).toBe("2345");
  });
  it("answers 416 past the end", async () => {
    expect((await get("tiles/0%201.b3dm", "bytes=50-")).status).toBe(416);
  });
  it("refuses paths outside the opened folder", async () => {
    expect((await get("../secret.txt")).status).toBe(404);
    expect((await get("%2e%2e/secret.txt")).status).toBe(404);
    expect((await get("tiles/..%2F..%2Fsecret.txt")).status).toBe(404);
    expect((await get("link.txt")).status).toBe(404);
  });
  it("refuses unknown folders", async () => {
    const r = await serveLocal(roots, new Request("viewer-file://nope/tileset.json"));
    expect(r.status).toBe(404);
  });
});
