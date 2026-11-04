import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { checkFiles, fromBytes, parseMetadataXml, resolvePath } from "./index";
import { geodeticToEcef } from "../geo/wgs84";

const enc = (s: string) => new TextEncoder().encode(s);

function glb(json: object, bin: Uint8Array | null = new Uint8Array(12)): Uint8Array {
  let j = enc(JSON.stringify(json));
  const pad = (4 - (j.length % 4)) % 4;
  j = Uint8Array.from([...j, ...Array(pad).fill(0x20)]);
  const binLen = bin ? bin.length + ((4 - (bin.length % 4)) % 4) : 0;
  const total = 12 + 8 + j.length + (bin ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true);
  dv.setUint32(4, 2, true);
  dv.setUint32(8, total, true);
  dv.setUint32(12, j.length, true);
  dv.setUint32(16, 0x4e4f534a, true);
  out.set(j, 20);
  if (bin) {
    dv.setUint32(20 + j.length, binLen, true);
    dv.setUint32(24 + j.length, 0x004e4942, true);
    out.set(bin, 28 + j.length);
  }
  return out;
}

const triangle = {
  asset: { version: "2.0" },
  scenes: [{ nodes: [0] }],
  nodes: [{ name: "Building A", mesh: 0 }],
  meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
  accessors: [{ count: 3 }],
  buffers: [{ byteLength: 12 }],
  bufferViews: [{ buffer: 0, byteLength: 12 }],
};

describe("loaders", () => {
  it("resolves relative paths", () => {
    expect(resolvePath("a/b/tileset.json", "../c/x%20y.glb")).toBe("a/c/x y.glb");
    expect(resolvePath("t.json", "data:abc")).toBeNull();
    expect(resolvePath("t.json", "https://x/y")).toBeNull();
  });

  it("accepts a valid GLB and reads its nodes and triangles", async () => {
    const { report } = await checkFiles([fromBytes("tri.glb", glb(triangle))]);
    expect(report.ok).toBe(true);
    expect(report.format).toBe("glb");
    expect(report.nodes).toEqual(["Building A"]);
    expect(report.stats.triangles).toBe(1);
  });

  it("names a file that is not a GLB", async () => {
    const { report } = await checkFiles([fromBytes("bad.glb", enc("hello world, not a model at all"))]);
    expect(report.ok).toBe(false);
    expect(report.items[0]!.detail).toMatch(/GLB signature/);
  });

  it("names a truncated GLB", async () => {
    const g = glb(triangle);
    const { report } = await checkFiles([fromBytes("cut.glb", g.subarray(0, g.length - 8))]);
    expect(report.ok).toBe(false);
    expect(report.items[0]!.detail).toMatch(/cut short/);
  });

  it("lists every missing file of a glTF, and unsupported required extensions", async () => {
    const g = { ...triangle, extensionsRequired: ["KHR_fancy"], buffers: [{ uri: "geo.bin", byteLength: 12 }], images: [{ uri: "tex/wall.png" }, { uri: "tex/roof.png" }] };
    const files = [fromBytes("m/model.gltf", enc(JSON.stringify(g))), fromBytes("m/tex/wall.png", new Uint8Array(4))];
    const { report } = await checkFiles(files);
    expect(report.ok).toBe(false);
    const refs = report.items.find((i) => i.id === "references")!;
    expect(refs.detail).toContain("geo.bin");
    expect(refs.detail).toContain("tex/roof.png");
    expect(refs.detail).not.toContain("wall");
    expect(report.items.find((i) => i.id === "extensions")!.detail).toBe("KHR_fancy");
  });

  it("reads a 3D Tiles set inside a zip, follows external tilesets and finds its position", async () => {
    const region = [0.6, 0.8, 0.61, 0.81, 100, 200];
    const root = { asset: { version: "1.1" }, geometricError: 100, root: { boundingVolume: { region }, geometricError: 50, children: [{ boundingVolume: { region }, geometricError: 0, content: { uri: "sub/tileset.json" } }] } };
    const sub = { asset: { version: "1.1" }, geometricError: 10, root: { boundingVolume: { region }, geometricError: 0, content: { uri: "a.glb" }, children: [{ boundingVolume: { region }, geometricError: 0, content: { uri: "missing.b3dm" } }] } };
    const zip = zipSync({ "city/tileset.json": enc(JSON.stringify(root)), "city/sub/tileset.json": enc(JSON.stringify(sub)), "city/sub/a.glb": glb(triangle) });
    const { report, files } = await checkFiles([fromBytes("city.zip", zip)]);
    expect(files.map((f) => f.path).sort()).toEqual(["sub/a.glb", "sub/tileset.json", "tileset.json"]);
    expect(report.format).toBe("3dtiles");
    expect(report.stats.tiles).toBe(4);
    expect(report.items.find((i) => i.id === "references")!.detail).toBe("missing.b3dm");
    expect(report.georef!.lat).toBeCloseTo(0.805 * (180 / Math.PI), 5);
  });

  it("flags a damaged tile", async () => {
    const ts = { asset: { version: "1.0" }, geometricError: 1, root: { boundingVolume: { sphere: [0, 0, 0, 1] }, geometricError: 0, content: { uri: "t.b3dm" } } };
    const { report } = await checkFiles([fromBytes("tileset.json", enc(JSON.stringify(ts))), fromBytes("t.b3dm", enc("<html>404</html>"))]);
    expect(report.items.find((i) => i.id === "content")!.severity).toBe("error");
    expect(report.items.find((i) => i.id === "georef")!.severity).toBe("warning");
  });

  it("recognises FBX and explains that the server converts it", async () => {
    const fbx = new Uint8Array(40);
    fbx.set(enc("Kaydara FBX Binary  \0\x1a\0"));
    new DataView(fbx.buffer).setUint32(23, 7400, true);
    const { report } = await checkFiles([fromBytes("house.fbx", fbx)]);
    expect(report.format).toBe("fbx");
    expect(report.items[0]!.title).toBe("FBX 7.4 binary");
    new DataView(fbx.buffer).setUint32(23, 538975364, true);
    const bad = await checkFiles([fromBytes("house.fbx", fbx)]);
    expect(bad.report.ok).toBe(false);
    expect(report.items.some((i) => i.id === "conversion")).toBe(true);
  });

  it("says what it found when there is no model", async () => {
    const { report } = await checkFiles([fromBytes("notes.txt", enc("hi"))]);
    expect(report.ok).toBe(false);
    expect(report.items[0]!.detail).toContain("txt");
  });
});

describe("loader plugins (WP 1.1)", () => {
  it("opens a new format from one plugin, with no change elsewhere", async () => {
    const { registerLoader, loaders, prepareFiles } = await import("./index");
    // A made-up ".tri" text format: three numbers per line, converted to a GLB in the browser.
    registerLoader({
      id: "tri-text",
      format: "glb",
      main: (set) => set.files.find((f) => f.path.endsWith(".tri")) ?? null,
      async check(main, set) {
        const lines = new TextDecoder().decode(await main.bytes()).trim().split("\n");
        const bad = lines.findIndex((l) => l.trim().split(/\s+/).length !== 3);
        return {
          items: [bad < 0 ? { id: "format", severity: "ok", title: "TRI text" } : { id: "format", severity: "error", title: `Line ${bad + 1} does not have three numbers` }],
          stats: { files: set.files.length, bytes: set.bytes, triangles: Math.floor(lines.length / 3) },
          nodes: ["tri"],
          georef: null,
        };
      },
      prepare: async (_main, _set, url) => url(glb(triangle), "model/gltf-binary"),
    });
    expect(loaders()[0]!.id).toBe("tri-text");
    const { report, files } = await checkFiles([fromBytes("shape.tri", enc("0 0 0\n1 0 0\n0 1 0"))]);
    expect(report).toMatchObject({ ok: true, loader: "tri-text", mainFile: "shape.tri", stats: { triangles: 1 } });
    const prepared = await prepareFiles(files, report);
    expect(prepared.kind).toBe("glb");
    expect(prepared.url).toMatch(/^blob:/);
    prepared.release();
    const broken = await checkFiles([fromBytes("shape.tri", enc("0 0 0\n1 0"))]);
    expect(broken.report.items[0]!.title).toBe("Line 2 does not have three numbers");
  });
});

describe("model size", () => {
  it("measures the scene through node transforms", async () => {
    const { gltfSize } = await import("./gltf");
    const g = {
      scenes: [{ nodes: [0] }],
      // Scaled ×100 (centimetres to… a mistake), then rotated 90° about X: y becomes z.
      nodes: [{ scale: [100, 100, 100], children: [1] }, { rotation: [Math.SQRT1_2, 0, 0, Math.SQRT1_2], mesh: 0 }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
      accessors: [{ count: 3, min: [0, 0, 0], max: [2, 1, 0.5] }],
    };
    const s = gltfSize(g)!;
    expect(s[0]).toBeCloseTo(200);
    expect(s[1]).toBeCloseTo(50);
    expect(s[2]).toBeCloseTo(100);
    const { report } = await checkFiles([fromBytes("tri.glb", glb({ ...triangle, accessors: [{ count: 3, min: [0, 0, 0], max: [4, 3, 0] }] }))]);
    expect(report.stats.size).toEqual([4, 3, 0]);
  });
});

describe("position carried by the file (WP 1.3)", () => {
  // Jerusalem at 800 m, in ECEF.
  const o = geodeticToEcef({ lat: 31.7767, lon: 35.2345, height: 800 });
  const box = { count: 3, min: [-5, -1, -5], max: [5, 1, 5] };
  const at = (g: object) => checkFiles([fromBytes("m.glb", glb({ ...triangle, accessors: [box], ...g }))]).then((r) => r.report);

  it("reads a CESIUM_RTC centre", async () => {
    const r = await at({ extensionsUsed: ["CESIUM_RTC"], extensions: { CESIUM_RTC: { center: [o.x, o.y, o.z] } } });
    expect(r.georef!.lat).toBeCloseTo(31.7767, 7);
    expect(r.georef!.lon).toBeCloseTo(35.2345, 7);
    expect(r.georef!.height).toBeCloseTo(800, 3);
    expect(r.items.find((i) => i.id === "georef")).toMatchObject({ severity: "ok", title: "Georeferenced" });
  });

  it("reads an Earth-centred node offset, Y-up as Cesium draws it", async () => {
    const r = await at({ nodes: [{ mesh: 0, translation: [o.x, o.z, -o.y] }] });
    expect(r.georef!.lat).toBeCloseTo(31.7767, 6);
    expect(r.georef!.lon).toBeCloseTo(35.2345, 6);
    expect(r.items.some((i) => i.title.startsWith("Vertex positions"))).toBe(false);
  });

  it("warns when the vertices themselves are Earth-centred", async () => {
    const r = await at({ accessors: [{ count: 3, min: [o.x - 5, o.z - 5, -o.y - 5], max: [o.x + 5, o.z + 5, -o.y + 5] }] });
    expect(r.georef).not.toBeNull();
    expect(r.items.find((i) => i.title.startsWith("Vertex positions"))).toMatchObject({ severity: "warning", title: "Vertex positions are only accurate to about 26 cm" });
  });

  it("leaves a model near the origin unplaced", async () => {
    const r = await at({});
    expect(r.georef).toBeNull();
    expect(r.filePosition).toBeUndefined();
  });

  it("takes the position from a ContextCapture metadata.xml beside the model", async () => {
    const xml = '<?xml version="1.0" encoding="utf-8"?>\n<ModelMetadata version="1">\n\t<SRS>EPSG:2039</SRS>\n\t<SRSOrigin>222303.615,631557.918,780.5</SRSOrigin>\n\t<Texture><ColorSource>Visible</ColorSource></Texture>\n</ModelMetadata>';
    const { report } = await checkFiles([fromBytes("site/Data/m.glb", glb(triangle)), fromBytes("site/metadata.xml", enc(xml))]);
    expect(report.georef).toBeNull();
    expect(report.filePosition).toEqual({ epsg: 2039, x: 222303.615, y: 631557.918, height: 780.5, source: "metadata.xml" });
    expect(report.items.filter((i) => i.id === "georef")).toEqual([{ id: "georef", severity: "ok", title: "Position from the export's metadata", detail: "metadata.xml: EPSG:2039, origin 222303.615, 631557.918, 780.5" }]);
  });

  it("reads ENU and compound systems, and names what it cannot use", () => {
    const enu = parseMetadataXml("<ModelMetadata><SRS>ENU:31.7767,35.2345</SRS><SRSOrigin>0,0,0</SRSOrigin></ModelMetadata>");
    expect(enu.position).toMatchObject({ epsg: 4326 });
    expect(enu.position!.x).toBeCloseTo(35.2345, 9);
    expect(enu.position!.y).toBeCloseTo(31.7767, 9);
    expect(parseMetadataXml("<SRS>EPSG:32636+5773</SRS><SRSOrigin>711594,3517858,0</SRSOrigin>").position).toMatchObject({ epsg: 32636, x: 711594 });
    expect(parseMetadataXml("<SRS>EPSG:9999</SRS>").items[0]).toMatchObject({ severity: "warning", detail: expect.stringContaining("EPSG:9999") });
    expect(parseMetadataXml('<SRS>PROJCS["x"]</SRS>').position).toBeNull();
  });
});
