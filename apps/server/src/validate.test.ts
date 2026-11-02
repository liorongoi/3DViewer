import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { summarise, validateOfficial } from "./validate.ts";

const enc = (t: string) => new TextEncoder().encode(t);
const pad = (b: Uint8Array, to: number, fill = 0x20) => Uint8Array.from([...b, ...Array((to - (b.length % to)) % to).fill(fill)]);

/** A valid one-triangle GLB. */
function glb(): Uint8Array {
  const bin = new Uint8Array(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer);
  const json = pad(
    enc(
      JSON.stringify({
        asset: { version: "2.0" },
        scene: 0,
        scenes: [{ nodes: [0] }],
        nodes: [{ mesh: 0 }],
        meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
        accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }],
        bufferViews: [{ buffer: 0, byteLength: 36 }],
        buffers: [{ byteLength: 36 }],
      }),
    ),
    4,
  );
  const out = new Uint8Array(12 + 8 + json.length + 8 + bin.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, json.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(json, 20);
  dv.setUint32(20 + json.length, bin.length, true);
  dv.setUint32(24 + json.length, 0x004e4942, true);
  out.set(bin, 28 + json.length);
  return out;
}

/** The GLB wrapped as b3dm with no padding at the end, as many real exporters write it. */
function b3dm(): Uint8Array {
  const ft = pad(enc(JSON.stringify({ BATCH_LENGTH: 0 })), 8);
  const g = glb();
  const out = new Uint8Array(28 + ft.length + g.length);
  const dv = new DataView(out.buffer);
  out.set(enc("b3dm"), 0);
  dv.setUint32(4, 1, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, ft.length, true);
  out.set(ft, 28);
  out.set(g, 28 + ft.length);
  return out;
}

function tileset(content: string, bytes: Uint8Array): string {
  const dir = mkdtempSync(path.join(tmpdir(), "val-"));
  const ts = { asset: { version: "1.1" }, geometricError: 10, root: { boundingVolume: { box: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, geometricError: 0, refine: "REPLACE", content: { uri: content } } };
  writeFileSync(path.join(dir, "tileset.json"), JSON.stringify(ts));
  writeFileSync(path.join(dir, content), bytes);
  return path.join(dir, "tileset.json");
}

/** A glTF whose only accessor points past the end of its buffer. */
function brokenGltf(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "val-"));
  const file = path.join(dir, "bad.gltf");
  writeFileSync(
    file,
    JSON.stringify({
      asset: { version: "2.0" },
      buffers: [{ byteLength: 12, uri: "data:application/octet-stream;base64,AAAAAAAAAAAAAAAA" }],
      bufferViews: [{ buffer: 0, byteLength: 12 }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [0, 0, 0] }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      nodes: [{ mesh: 0 }],
      scenes: [{ nodes: [0] }],
      scene: 0,
    }),
  );
  return file;
}

describe("official validators (WP 3.3)", () => {
  it("passes a clean GLB", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "val-"));
    writeFileSync(path.join(dir, "ok.glb"), glb());
    const item = await validateOfficial("glb", path.join(dir, "ok.glb"));
    expect(item).toMatchObject({ id: "validator", severity: "ok" });
    expect(item.title).toMatch(/^Passed the official glTF validator/);
  });

  it("lists glTF errors as a warning, or blocks with strict", async () => {
    const file = brokenGltf();
    const loose = await validateOfficial("gltf", file);
    expect(loose.severity).toBe("warning");
    expect(loose.title).toMatch(/found \d+ errors?; the model still loads/);
    expect(loose.detail).toMatch(/bad\.gltf/);
    const strict = await validateOfficial("gltf", file, { strict: true });
    expect(strict.severity).toBe("error");
  });

  it("validates a tileset and its tile contents", async () => {
    expect(await validateOfficial("3dtiles", tileset("0.glb", glb()))).toMatchObject({ severity: "ok", title: "Passed the official 3D Tiles validator" });
    // A misaligned b3dm, as in many real tilesets: listed, but it does not stop publishing.
    const item = await validateOfficial("3dtiles", tileset("0.b3dm", b3dm()));
    expect(item).toMatchObject({ severity: "warning" });
    expect(item.title).toMatch(/^The official 3D Tiles validator found \d+ errors?; the model still loads$/);
    expect(item.detail).toMatch(/0\.b3dm/);
  }, 60_000);

  it("says so when the validator runs too long", async () => {
    const item = await validateOfficial("3dtiles", tileset("0.glb", glb()), { timeoutMs: 1 });
    expect(item).toMatchObject({ severity: "warning", title: "The official 3D Tiles validator did not finish" });
  });

  it("groups the same problem across files", () => {
    const issues = Array.from({ length: 72 }, (_, i) => ({ severity: "ERROR" as const, code: "BINARY_INVALID_ALIGNMENT", message: "The byte length must be aligned to 8 bytes", path: `tiles/${i}.b3dm` }));
    issues.push({ severity: "ERROR", code: "X", message: "Other", path: "a.glb" });
    expect(summarise(issues, "ERROR")).toBe("×72 The byte length must be aligned to 8 bytes (tiles/0.b3dm, tiles/1.b3dm, tiles/2.b3dm, …)\nOther (a.glb)");
  });
});
