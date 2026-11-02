import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { summarise, validateOfficial } from "./validate.ts";

const samples = fileURLToPath(new URL("../../web/public/samples/", import.meta.url));

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
    const item = await validateOfficial("glb", path.join(samples, "khronos/BoomBox.glb"));
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
    const item = await validateOfficial("3dtiles", path.join(samples, "3dtiles/TilesetWithDiscreteLOD/tileset.json"));
    expect(item.id).toBe("validator");
    // A Cesium sample with one misaligned b3dm tile: listed, but it does not stop publishing.
    expect(item).toMatchObject({ severity: "warning", title: "The official 3D Tiles validator found 1 error; the model still loads" });
    expect(item.detail).toMatch(/aligned to 8 bytes \(dragon_high\.b3dm\)/);
  }, 60_000);

  it("says so when the validator runs too long", async () => {
    const item = await validateOfficial("3dtiles", path.join(samples, "3dtiles/TilesetWithDiscreteLOD/tileset.json"), { timeoutMs: 1 });
    expect(item).toMatchObject({ severity: "warning", title: "The official 3D Tiles validator did not finish" });
  });

  it("groups the same problem across files", () => {
    const issues = Array.from({ length: 72 }, (_, i) => ({ severity: "ERROR" as const, code: "BINARY_INVALID_ALIGNMENT", message: "The byte length must be aligned to 8 bytes", path: `tiles/${i}.b3dm` }));
    issues.push({ severity: "ERROR", code: "X", message: "Other", path: "a.glb" });
    expect(summarise(issues, "ERROR")).toBe("×72 The byte length must be aligned to 8 bytes (tiles/0.b3dm, tiles/1.b3dm, tiles/2.b3dm, …)\nOther (a.glb)");
  });
});
