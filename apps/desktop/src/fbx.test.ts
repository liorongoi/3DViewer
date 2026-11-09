import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { convertFbx, findConverter } from "./fbx";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vfbx-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A stand-in for FBX2glTF: a Node script that does what `body` says with its arguments. */
function fake(name: string, body: string): string {
  const p = path.join(dir, name);
  fs.writeFileSync(p, `#!${process.execPath}\nconst fs = require("node:fs");\nconst a = process.argv;\nconst out = a[a.indexOf("--output") + 1];\n${body}\n`);
  fs.chmodSync(p, 0o755);
  return p;
}
const input = path.join(dir, "Water tower.fbx");
fs.writeFileSync(input, "Kaydara FBX Binary  \0");

describe.skipIf(process.platform === "win32")("local FBX conversion", () => {
  it("writes the GLB into its own work folder", async () => {
    const bin = fake("ok.cjs", `fs.writeFileSync(out + ".glb", "glTF....");`);
    const r = await convertFbx(bin, input, { workDir: path.join(dir, "w1") });
    expect(r).toMatchObject({ ok: true, glb: path.join(dir, "w1", "Water tower.glb") });
  });
  it("runs with nothing of the user's environment, in its work folder", async () => {
    process.env.VIEWER_SECRET_FOR_TEST = "x";
    const bin = fake("env.cjs", `fs.writeFileSync(out + ".glb", JSON.stringify({ env: Object.keys(process.env), cwd: process.cwd() }));`);
    const r = await convertFbx(bin, input, { workDir: path.join(dir, "w2") });
    delete process.env.VIEWER_SECRET_FOR_TEST;
    if (!r.ok) throw new Error(r.detail);
    const seen = JSON.parse(fs.readFileSync(r.glb, "utf8")) as { env: string[]; cwd: string };
    expect(seen.env).not.toContain("VIEWER_SECRET_FOR_TEST");
    expect(seen.env).not.toContain("PATH");
    expect(fs.realpathSync(seen.cwd)).toBe(fs.realpathSync(path.join(dir, "w2")));
  });
  it("reports a failure with the converter's last words", async () => {
    const bin = fake("bad.cjs", `console.error("ERROR: unsupported FBX version"); process.exit(1);`);
    expect(await convertFbx(bin, input, { workDir: path.join(dir, "w3") })).toEqual({ ok: false, reason: "failed", detail: "ERROR: unsupported FBX version" });
  });
  it("fails when nothing was written", async () => {
    const bin = fake("empty.cjs", ``);
    expect(await convertFbx(bin, input, { workDir: path.join(dir, "w4") })).toMatchObject({ ok: false, reason: "failed" });
  });
  it("stops a converter that runs too long", async () => {
    const bin = fake("slow.cjs", `setTimeout(() => {}, 60000);`);
    expect(await convertFbx(bin, input, { workDir: path.join(dir, "w5"), timeoutMs: 500 })).toMatchObject({ ok: false, reason: "timeout" });
  });
  it("finds the converter: next to the installed app only, or from the environment in development", () => {
    const bin = fake("found.cjs", "");
    expect(findConverter({ env: { VIEWER_FBX2GLTF: bin }, packaged: false, resourcesPath: "/nowhere", here: dir })).toBe(bin);
    expect(findConverter({ env: { VIEWER_FBX2GLTF: bin }, packaged: true, resourcesPath: "/nowhere", here: dir })).toBeNull();
  });
});

describe("the real converter", () => {
  // The real FBX2glTF from the npm package (Linux CI, the Windows installer job, development).
  const real = findConverter({ env: {}, packaged: false, resourcesPath: "", here: path.resolve(__dirname) });
  it.skipIf(!real || process.platform === "darwin")("converts a real FBX with the real converter", async () => {
    // The smallest valid FBX: an ASCII 7.4 file with one triangle.
    const tri = path.join(dir, "tri.fbx");
    fs.writeFileSync(tri, ASCII_TRIANGLE);
    const r = await convertFbx(real!, tri, { workDir: path.join(dir, "w6") });
    if (!r.ok) throw new Error(r.detail);
    expect(fs.readFileSync(r.glb).subarray(0, 4).toString()).toBe("glTF");
  });
});

const ASCII_TRIANGLE = `; FBX 7.4.0 project file
FBXHeaderExtension:  {
	FBXHeaderVersion: 1003
	FBXVersion: 7400
}
GlobalSettings:  {
	Version: 1000
	Properties70:  {
		P: "UpAxis", "int", "Integer", "",1
		P: "UpAxisSign", "int", "Integer", "",1
		P: "FrontAxis", "int", "Integer", "",2
		P: "FrontAxisSign", "int", "Integer", "",1
		P: "CoordAxis", "int", "Integer", "",0
		P: "CoordAxisSign", "int", "Integer", "",1
		P: "UnitScaleFactor", "double", "Number", "",100
	}
}
Objects:  {
	Geometry: 1000, "Geometry::Tri", "Mesh" {
		Vertices: *9 {
			a: 0,0,0,100,0,0,0,100,0
		}
		PolygonVertexIndex: *3 {
			a: 0,1,-3
		}
	}
	Model: 2000, "Model::Tri", "Mesh" {
		Version: 232
	}
}
Connections:  {
	C: "OO",2000,0
	C: "OO",1000,2000
}
`;
