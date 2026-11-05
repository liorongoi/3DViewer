import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { MeshoptDecoder } from "meshoptimizer";
import { describe, expect, it } from "vitest";
import { optimiseGlb } from "./optimise.ts";
import { gridGlb } from "./test-models.ts";
import { optimiseGlbInWorker } from "./tiler.ts";
import { validateOfficial } from "./validate.ts";

const read = async (f: string) => {
  await MeshoptDecoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "meshopt.decoder": MeshoptDecoder }).read(f);
};

describe("optimise (WP 3.4)", () => {
  it("makes a GLB smaller with every position, UV, index and node as it was", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opt-"));
    const input = path.join(dir, "in.glb");
    const output = path.join(dir, "out.glb");
    writeFileSync(input, gridGlb(200)); // 80,000 triangles
    const r = await optimiseGlb(input, output);
    expect(r.written).toBe(true);
    expect(r.after).toBeLessThan(r.before * 0.8);
    expect(readFileSync(output).length).toBe(r.after);
    const a = await read(input);
    const b = await read(output);
    expect(b.getRoot().listExtensionsRequired().map((e) => e.extensionName)).toEqual(expect.arrayContaining(["EXT_meshopt_compression", "KHR_mesh_quantization"]));
    const pa = a.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    const pb = b.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    for (const attr of ["POSITION", "TEXCOORD_0"]) expect(Array.from(pb.getAttribute(attr)!.getArray()!)).toEqual(Array.from(pa.getAttribute(attr)!.getArray()!));
    expect(Array.from(pb.getIndices()!.getArray()!)).toEqual(Array.from(pa.getIndices()!.getArray()!));
    // Normals keep their direction to within a degree.
    const na = pa.getAttribute("NORMAL")!, nb = pb.getAttribute("NORMAL")!;
    const x: number[] = [], y: number[] = [];
    for (let i = 0; i < na.getCount(); i += 997) {
      const dot = na.getElement(i, x).reduce((t, v, k) => t + v * nb.getElement(i, y)[k]!, 0);
      expect(dot).toBeGreaterThan(Math.cos((1 * Math.PI) / 180));
    }
    expect(b.getRoot().listNodes().map((n) => n.getName())).toEqual(a.getRoot().listNodes().map((n) => n.getName()));
    expect(await validateOfficial("glb", output)).toMatchObject({ severity: "ok" });
  }, 60_000);

  it("runs on a worker, and writes nothing when the saving is too small", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opt-"));
    writeFileSync(path.join(dir, "in.glb"), gridGlb(200));
    expect(await optimiseGlbInWorker(path.join(dir, "in.glb"), path.join(dir, "out.glb"))).toMatchObject({ written: true });
    expect(existsSync(path.join(dir, "out.glb"))).toBe(true);
    const tiny = await optimiseGlb(path.join(dir, "in.glb"), path.join(dir, "x.glb"), 0.99);
    expect(tiny).toMatchObject({ written: false });
    expect(existsSync(path.join(dir, "x.glb"))).toBe(false);
  }, 60_000);
});
