import { describe, expect, it } from "vitest";
import { gunzipSync, gzipSync } from "fflate";
import { decodePly, decodeSpz, encodeSpzV2, packRotationV3, splatFileToTiles, splatTiles, SPZ_MAGIC, unpackRotation, unpackSh, unpackScale, unpackColor, type SplatCloud } from ".";
import { checkFiles, fromBytes, parseGlb as parseGlbTyped } from "../loaders";

// The tests read the splat-specific parts of the glTF JSON, which the loader's type leaves out.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const parseGlb = (d: Uint8Array) => parseGlbTyped(d) as { json: any; bin: Uint8Array | null };

/** A Gaussian splat PLY as trainers write it (COLMAP frame), from float rows. */
function ply(rows: number[][], rest: number, extra: string[] = []): Uint8Array {
  const props = ["x", "y", "z", ...extra, "f_dc_0", "f_dc_1", "f_dc_2", ...Array.from({ length: rest }, (_, i) => `f_rest_${i}`), "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
  const head = `ply\nformat binary_little_endian 1.0\nelement vertex ${rows.length}\n${props.map((p) => `property float ${p}`).join("\n")}\nend_header\n`;
  const h = new TextEncoder().encode(head);
  const body = new Float32Array(rows.length * props.length);
  rows.forEach((r, i) => body.set(r, i * props.length));
  const out = new Uint8Array(h.length + body.byteLength);
  out.set(h);
  out.set(new Uint8Array(body.buffer), h.length);
  return out;
}

/** A row: position, dc, rest, opacity, log scales, quaternion w x y z. */
const row = (p: number[], rest: number[] = [], q = [1, 0, 0, 0], extra: number[] = []) => [...p, ...extra, 0.2, -0.1, 0.4, ...rest, 2, -3, -4, -5, ...q];

function quatToMatrix([x, y, z, w]: number[]): number[][] {
  return [
    [1 - 2 * (y! * y! + z! * z!), 2 * (x! * y! - z! * w!), 2 * (x! * z! + y! * w!)],
    [2 * (x! * y! + z! * w!), 1 - 2 * (x! * x! + z! * z!), 2 * (y! * z! - x! * w!)],
    [2 * (x! * z! - y! * w!), 2 * (y! * z! + x! * w!), 1 - 2 * (x! * x! + y! * y!)],
  ];
}

function cloudOf(n: number, spread = 10): SplatCloud {
  const pos = new Float32Array(n * 3);
  let s = 7;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let i = 0; i < n * 3; i++) pos[i] = Math.round(rnd() * spread * 4096) / 4096;
  return {
    count: n,
    shDegree: 1,
    fractionalBits: 12,
    flags: 0,
    pos,
    alphas: new Uint8Array(n).fill(200),
    colors: new Uint8Array(n * 3).fill(100),
    scales: new Uint8Array(n * 3).fill(96),
    rotations: new Uint8Array(n * 3).fill(128),
    sh: new Uint8Array(n * 9).fill(136),
  };
}

describe("SPZ", () => {
  it("writes version 2 and reads it back exactly", () => {
    const c = cloudOf(500);
    const d = decodeSpz(encodeSpzV2(c));
    expect(d.header).toMatchObject({ version: 2, count: 500, shDegree: 1, fractionalBits: 12 });
    expect(Array.from(d.cloud.pos)).toEqual(Array.from(c.pos));
    for (const k of ["alphas", "colors", "scales", "rotations", "sh"] as const) expect(Array.from(d.cloud[k])).toEqual(Array.from(c[k]));
  });

  it("reads version 3 rotations (smallest three) as version 2 within 8-bit precision", () => {
    const c = cloudOf(4);
    const v2 = gunzipSync(encodeSpzV2(c));
    const qs: [number, number, number, number][] = [[0, 0, 0, 1], [0.5, -0.5, 0.5, -0.5], [0.1, 0.9, -0.3, 0.2], [-0.7, 0.1, 0.1, 0.7]];
    const n = 4;
    const rotAt = 16 + n * 16;
    const v3 = new Uint8Array(v2.length + n);
    v3.set(v2.subarray(0, rotAt));
    new DataView(v3.buffer).setUint32(4, 3, true);
    qs.forEach((q, i) => packRotationV3(q, v3, rotAt + i * 4));
    v3.set(v2.subarray(rotAt + n * 3), rotAt + n * 4);
    const d = decodeSpz(gzipSync(v3));
    expect(d.header.version).toBe(3);
    qs.forEach((q, i) => {
      const nq = Math.hypot(...q);
      const want = quatToMatrix(q.map((x) => x / nq));
      const got = quatToMatrix(unpackRotation(d.cloud.rotations, i));
      for (let r = 0; r < 3; r++) for (let k = 0; k < 3; k++) expect(got[r]![k]!).toBeCloseTo(want[r]![k]!, 1);
    });
  });

  const raw = (mut: (b: Uint8Array) => Uint8Array) => gzipSync(mut(gunzipSync(encodeSpzV2(cloudOf(10)))));
  it.each([
    ["version 1", raw((b) => (new DataView(b.buffer).setUint32(4, 1, true), b)), /version 1/],
    ["SH degree 4", raw((b) => ((b[12] = 4), b)), /degree 4/],
    ["truncated", raw((b) => b.subarray(0, b.length - 5)), /cut short/],
    ["trailing bytes", raw((b) => { const o = new Uint8Array(b.length + 3); o.set(b); return o; }), /after its splats/],
    ["a wrong magic", raw((b) => ((b[0] = 0), b)), /NGSP/],
    ["no splats", raw((b) => (new DataView(b.buffer).setUint32(8, 0, true), b)), /no splats/],
    ["too many splats", raw((b) => (new DataView(b.buffer).setUint32(8, 50_000_000, true), b)), /limit/],
  ])("refuses %s with the reason", (_n, data, why) => {
    expect(() => decodeSpz(data)).toThrow(why);
  });

  it("refuses version 4 (Zstandard) and non-gzip data by name", () => {
    const h = new Uint8Array(32);
    new DataView(h.buffer).setUint32(0, SPZ_MAGIC, true);
    new DataView(h.buffer).setUint32(4, 4, true);
    expect(() => decodeSpz(h)).toThrow(/version 4/);
    expect(() => decodeSpz(new TextEncoder().encode("hello world, not a splat file"))).toThrow(/not an SPZ/);
  });

  it("refuses a gzip bomb from its declared size, before inflating", () => {
    const data = encodeSpzV2(cloudOf(3));
    new DataView(data.buffer, data.byteOffset).setUint32(data.byteLength - 4, 0xfffffff0, true);
    expect(() => decodeSpz(data)).toThrow(/expands to/);
  });
});

describe("Gaussian splat PLY", () => {
  it("turns COLMAP's frame (y down, z forward) into glTF's (y up, z back)", () => {
    const { cloud, info } = decodePly(ply([row([1, 2, 3]), row([-4, 0.5, 0])], 0));
    expect(info).toMatchObject({ count: 2, shDegree: 0 });
    expect(Array.from(cloud.pos)).toEqual([1, -2, -3, -4, -0.5, -0]);
    expect(unpackScale(cloud.scales[0]!)).toBeCloseTo(-3, 1);
    expect(unpackColor(cloud.colors[0]!)).toBeCloseTo(0.2, 1);
    expect(cloud.alphas[0]).toBe(Math.round(255 / (1 + Math.exp(-2))));
  });

  it("turns each splat's shape with it", () => {
    // A splat 3 × 2 × 1 turned 90° about z, in COLMAP's frame. Its covariance R S² Rᵀ must become F Σ F.
    const a = Math.SQRT1_2;
    const prop = ply([[0, 0, 0, 0.2, -0.1, 0.4, 2, Math.log(3), Math.log(2), 0, a, 0, 0, a]], 0);
    const { cloud } = decodePly(prop);
    const cov = (R: number[][], s: number[]) => [0, 1, 2].map((i) => [0, 1, 2].map((j) => [0, 1, 2].reduce((t, k) => t + R[i]![k]! * s[k]! ** 2 * R[j]![k]!, 0)));
    const s = [0, 1, 2].map((k) => Math.exp(unpackScale(cloud.scales[k]!)));
    const got = cov(quatToMatrix(unpackRotation(cloud.rotations, 0)), s);
    const F = [1, -1, -1];
    const Sc = cov(quatToMatrix([0, 0, a, a]), [3, 2, 1]);
    const want = [0, 1, 2].map((i) => [0, 1, 2].map((j) => F[i]! * Sc[i]![j]! * F[j]!));
    // Within SPZ's 8-bit precision (log scale in steps of 1/16, about 6 % on a variance; rotations in steps of 1/127).
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(Math.abs(got[i]![j]! - want[i]![j]!)).toBeLessThan(0.1 * Math.max(1, Math.abs(want[i]![j]!)) + 0.1);
    expect(Math.abs(got[0]![0]! - 4)).toBeLessThan(0.4);
    expect(Math.abs(got[1]![1]! - 9)).toBeLessThan(0.9);
  });

  it("reorders the SH rest coefficient by coefficient and flips the odd ones", () => {
    // 9 values: red j0..j2, green j0..j2, blue j0..j2.
    const rest = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, -0.1, -0.2, -0.3];
    const { cloud } = decodePly(ply([row([0, 0, 0], rest)], 9));
    expect(cloud.shDegree).toBe(1);
    const sh = Array.from(cloud.sh).map(unpackSh);
    // Coefficient 0 (∝ y) and 1 (∝ z) change sign; 2 (∝ x) does not.
    const want = [-0.1, -0.4, 0.1, -0.2, -0.5, 0.2, 0.3, 0.6, -0.3];
    sh.forEach((v, i) => expect(v).toBeCloseTo(want[i]!, 1));
  });

  it.each([
    ["a mesh", "ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n", /mesh/],
    ["a point cloud", "ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nend_header\n", /point cloud/],
    ["ASCII", "ply\nformat ascii 1.0\nelement vertex 1\nproperty float x\nend_header\n0\n", /ASCII/],
    ["not a PLY", "solid cube\n", /not a PLY/],
  ])("refuses %s with the reason", (_n, text, why) => {
    expect(() => decodePly(new TextEncoder().encode(text))).toThrow(why);
  });

  it("refuses a truncated PLY", () => {
    const data = ply([row([0, 0, 0]), row([1, 1, 1])], 0);
    expect(() => decodePly(data.subarray(0, data.length - 10))).toThrow(/cut short/);
  });
});

describe("splats as 3D Tiles", () => {
  it("puts an uploaded SPZ v2 into the tile byte for byte", () => {
    const spz = encodeSpzV2(cloudOf(50));
    const t = splatFileToTiles("scene.spz", spz);
    expect(t.info).toMatchObject({ format: "spz", version: 2, count: 50, conversion: "unchanged" });
    const glb = parseGlb(t.files.find((f) => f.path === "splats.glb")!.data);
    expect(Array.from(glb.bin!.subarray(0, spz.byteLength))).toEqual(Array.from(spz));
    const ts = JSON.parse(new TextDecoder().decode(t.files.find((f) => f.path === "tileset.json")!.data));
    expect(ts.extensions["3DTILES_content_gltf"].extensionsRequired).toEqual(["KHR_gaussian_splatting", "KHR_gaussian_splatting_compression_spz_2"]);
    expect(glb.json.meshes[0].primitives[0].extensions.KHR_gaussian_splatting.extensions.KHR_gaussian_splatting_compression_spz_2).toEqual({ bufferView: 0 });
    expect(Object.keys(glb.json.meshes[0].primitives[0].attributes)).toContain("KHR_gaussian_splatting:SH_DEGREE_1_COEF_2");
  });

  it("splits a large cloud into tiles that keep every splat in the leaves", () => {
    const c = cloudOf(5000, 3000);
    const t = splatTiles(c, { singleMax: 1000, leafMax: 800 });
    expect(t.tiles).toBeGreaterThan(7);
    const ts = JSON.parse(new TextDecoder().decode(t.files.find((f) => f.path === "tileset.json")!.data));
    let leafSplats = 0;
    const leafPositions: number[][] = [];
    const walk = (tile: { content: { uri: string }; children?: unknown[]; transform: number[] }, at: number[]) => {
      // 3D Tiles (x, y, z) translation back to glTF axes: (x, z, −y).
      const o = [at[0]! + tile.transform[12]!, at[1]! + tile.transform[14]!, at[2]! - tile.transform[13]!];
      if (!tile.children) {
        const glb = parseGlb(t.files.find((f) => f.path === tile.content.uri)!.data);
        const d = decodeSpz(glb.bin!.subarray(0, glb.json.bufferViews[0].byteLength));
        leafSplats += d.cloud.count;
        for (let i = 0; i < d.cloud.count; i++) leafPositions.push([0, 1, 2].map((a) => d.cloud.pos[i * 3 + a]! + o[a]!));
      } else (tile.children as typeof tile[]).forEach((ch) => walk(ch, o));
    };
    walk(ts.root, [0, 0, 0]);
    expect(leafSplats).toBe(5000);
    // Every splat is back where it was, within the coarser fixed-point step of a wide tile.
    const key = (p: number[]) => p.map((v) => Math.round(v)).join(",");
    const want = new Set(Array.from({ length: 5000 }, (_, i) => key([0, 1, 2].map((a) => c.pos[i * 3 + a]!))));
    const near = leafPositions.filter((p) => want.has(key(p))).length;
    expect(near).toBeGreaterThan(4950);
  });

  it("frames the model without floaters", () => {
    const c = cloudOf(2000, 5);
    c.pos[0] = 4000;
    const t = splatTiles(c);
    expect(t.extent.max[0]).toBe(4000);
    expect(t.focus.max[0]).toBeLessThan(6);
  });
});

describe("the upload check", () => {
  it("accepts a splat PLY, says what it is and how it will be drawn", async () => {
    const { report } = await checkFiles([fromBytes("room/point_cloud.ply", ply([row([0, 0, 0]), row([2, 1, 4])], 0))]);
    expect(report).toMatchObject({ ok: true, format: "ply", loader: "splat", stats: { splats: 2, shDegree: 0 }, splat: { conversion: "ply-to-spz2" } });
    expect(report.items.map((i) => i.key)).toEqual(expect.arrayContaining(["splatPly", "splat_ply_to_spz2", "noPosition"]));
  });

  it("refuses a damaged SPZ before anything is published", async () => {
    const bad = encodeSpzV2(cloudOf(10)).slice(0, 40);
    const { report } = await checkFiles([fromBytes("scene.spz", bad)]);
    expect(report.ok).toBe(false);
    expect(report.items[0]).toMatchObject({ key: "splatUnreadable", severity: "error" });
  });

  it("keeps meshes on their own loaders", async () => {
    const { report } = await checkFiles([fromBytes("mesh.ply", new TextEncoder().encode("ply\nformat binary_little_endian 1.0\nelement vertex 0\nproperty float x\nelement face 0\nproperty list uchar int vertex_indices\nend_header\n"))]);
    expect(report.ok).toBe(false);
    expect(report.items[0]!.detail).toMatch(/mesh/);
  });
});
