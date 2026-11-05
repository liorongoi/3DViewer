// Models built in code for the tests, so they need no sample files.

/** A 1×1 PNG. */
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));

/**
 * A wavy n×n grid (2n² triangles), 100 m across, in the glTF's y-up frame, with normals, UVs
 * and one textured material; `zUp` lays it in x-y instead, as a Z-up exporter would.
 */
export function gridGlb(n: number, zUp = false): Uint8Array {
  const nv = (n + 1) * (n + 1);
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) {
    const v = j * (n + 1) + i;
    const x = (i / n) * 100 - 50, z = (j / n) * 100 - 50, h = 2 * Math.sin(i / 3) * Math.cos(j / 4);
    pos.set(zUp ? [x, -z, h] : [x, h, z], v * 3);
    nor.set(zUp ? [0, 0, 1] : [0, 1, 0], v * 3);
    uv.set([i / n, j / n], v * 2);
  }
  const idx = new Uint32Array(n * n * 6);
  let k = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const a = j * (n + 1) + i, b = a + 1, c = a + n + 1, d = c + 1;
    // Counter-clockwise seen from above in both frames (the Z-up copy mirrors z into -y).
    idx.set([a, c, b, b, c, d], k);
    k += 6;
  }
  const parts = [pos, nor, uv, idx, PNG].map((p) => new Uint8Array(p.buffer, p.byteOffset, p.byteLength));
  const views: object[] = [];
  let off = 0;
  for (const p of parts) views.push({ buffer: 0, byteOffset: off, byteLength: p.length }), (off += p.length + ((4 - (p.length % 4)) % 4));
  // A loop, not Math.min(...all): spreading a large grid overflows the call stack.
  const mn = [Infinity, Infinity, Infinity];
  const mx = [-Infinity, -Infinity, -Infinity];
  for (let v = 0; v < nv; v++)
    for (let c = 0; c < 3; c++) {
      mn[c] = Math.min(mn[c]!, pos[v * 3 + c]!);
      mx[c] = Math.max(mx[c]!, pos[v * 3 + c]!);
    }
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "Terrain" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 }, metallicFactor: 0 } }],
    textures: [{ source: 0, sampler: 0 }],
    samplers: [{ wrapS: 33071, wrapT: 33071 }],
    images: [{ bufferView: 4, mimeType: "image/png" }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: nv, type: "VEC3", min: mn, max: mx },
      { bufferView: 1, componentType: 5126, count: nv, type: "VEC3" },
      { bufferView: 2, componentType: 5126, count: nv, type: "VEC2" },
      { bufferView: 3, componentType: 5125, count: idx.length, type: "SCALAR" },
    ],
    bufferViews: views,
    buffers: [{ byteLength: off }],
  };
  const j = Buffer.from(JSON.stringify(json));
  const jl = j.length + ((4 - (j.length % 4)) % 4);
  const out = new Uint8Array(28 + jl + off);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, out.length, true);
  dv.setUint32(12, jl, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  out.fill(0x20, 20 + j.length, 20 + jl);
  dv.setUint32(20 + jl, off, true);
  dv.setUint32(24 + jl, 0x004e4942, true);
  let o = 28 + jl;
  for (let i = 0; i < parts.length; i++) out.set(parts[i]!, o), (o += parts[i]!.length + ((4 - (parts[i]!.length % 4)) % 4));
  return out;
}
