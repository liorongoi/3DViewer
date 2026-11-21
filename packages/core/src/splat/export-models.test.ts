import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { glbTilesetZip, glbToGltf, tilesetZip } from "./export";

/** A minimal GLB: a JSON chunk naming one buffer, and a BIN chunk. */
function glb(json: object, bin: Uint8Array): Uint8Array {
  const pad = (b: Uint8Array, fill: number) => {
    const n = Math.ceil(b.length / 4) * 4;
    const o = new Uint8Array(n).fill(fill);
    o.set(b);
    return o;
  };
  const j = pad(new TextEncoder().encode(JSON.stringify(json)), 0x20);
  const b = pad(bin, 0);
  const out = new Uint8Array(12 + 8 + j.length + 8 + b.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, j.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  dv.setUint32(20 + j.length, b.length, true);
  dv.setUint32(24 + j.length, 0x004e4942, true);
  out.set(b, 28 + j.length);
  return out;
}

describe("exporting models", () => {
  const bin = new Uint8Array([1, 2, 3, 4, 5, 6, 7]);
  const json = { asset: { version: "2.0" }, buffers: [{ byteLength: 7 }], bufferViews: [{ buffer: 0, byteLength: 7 }], images: [{ bufferView: 0, mimeType: "image/png" }] };

  it("splits a GLB into a glTF and its .bin, images kept inside", () => {
    const out = glbToGltf(glb(json, bin), "Big hall");
    expect(Object.keys(out).sort()).toEqual(["Big hall.bin", "Big hall.gltf"]);
    const g = JSON.parse(new TextDecoder().decode(out["Big hall.gltf"]));
    expect(g.buffers[0]).toEqual({ byteLength: 7, uri: "Big%20hall.bin" });
    expect(g.images[0]).toEqual({ bufferView: 0, mimeType: "image/png" });
    expect([...out["Big hall.bin"]!]).toEqual([...bin]);
    expect(() => glbToGltf(new Uint8Array(30), "x")).toThrow(/not a glTF 2\.0/);
    expect(() => glbToGltf(glb({ ...json, buffers: [{ byteLength: 7 }, { byteLength: 3, uri: "more.bin" }] }, bin), "x")).not.toThrow();
    expect(() => glbToGltf(glb({ ...json, buffers: [{ byteLength: 7, uri: "elsewhere.bin" }] }, bin), "x")).toThrow(/outside itself/);
  });

  it("wraps a placed GLB as a one-tile 3D Tiles set", async () => {
    const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4e6, 3e6, 3.5e6, 1];
    const z = unzipSync(await glbTilesetZip(glb(json, bin), "hall", T, [0, 1, 0, 25]));
    const ts = JSON.parse(new TextDecoder().decode(z["tileset.json"]));
    expect(ts.root).toMatchObject({ transform: T, boundingVolume: { sphere: [0, 1, 0, 25] }, content: { uri: "hall.glb" } });
    expect(z["hall.glb"]!.length).toBeGreaterThan(20);
  });

  it("refuses a tileset it cannot copy whole rather than writing part of it", async () => {
    const implicit = { asset: { version: "1.1" }, root: { implicitTiling: { subdivisionScheme: "QUADTREE" }, content: { uri: "content/{level}/{x}/{y}.glb" } } };
    const get = async () => new TextEncoder().encode(JSON.stringify(implicit));
    await expect(tilesetZip("https://example.test/t/tileset.json", get)).rejects.toThrow(/implicit tiling/);
  });
});
