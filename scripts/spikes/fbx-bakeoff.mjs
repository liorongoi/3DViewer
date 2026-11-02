// WP 0.4 FBX bake-off spike: convert each FBX with each candidate, validate the GLB, count content.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const validator = require("gltf-validator");
const IN = process.argv[2], OUT = process.argv[3];

// --- candidates ---
const ajs = await require("assimpjs")();
async function assimp(file, out) {
  const fl = new ajs.FileList();
  fl.AddFile(path.basename(file), new Uint8Array(fs.readFileSync(file)));
  const r = ajs.ConvertFileList(fl, "glb2");
  if (!r.IsSuccess() || r.FileCount() === 0) throw new Error(r.GetErrorCode());
  fs.writeFileSync(out, Buffer.from(r.GetFile(0).GetContent()));
}
function fbx2gltf(file, out) {
  execFileSync(path.resolve("node_modules/fbx2gltf/bin/Linux/FBX2glTF"), ["--binary", "--input", file, "--output", out.replace(/\.glb$/, "")], { stdio: "pipe", timeout: 300000 });
}
// three.js FBXLoader + GLTFExporter (runs in the browser too); Node needs a FileReader shim.
globalThis.FileReader = class { readAsArrayBuffer(b) { b.arrayBuffer().then((r) => { this.result = r; this.onloadend?.(); }); } readAsDataURL(b) { b.arrayBuffer().then((r) => { this.result = "data:application/octet-stream;base64," + Buffer.from(r).toString("base64"); this.onloadend?.(); }); } };
globalThis.self = globalThis; globalThis.window ??= globalThis;
const THREE = await import("three");
// Run: node scripts/spikes/fbx-bakeoff.mjs <dir with .fbx> <out dir>, after npm i assimpjs@0.0.10 fbx2gltf@0.9.7-p1 gltf-validator three@0.170.0
const { FBXLoader } = await import("three/examples/jsm/loaders/FBXLoader.js");
const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
THREE.TextureLoader.prototype.load = () => new THREE.Texture(); // no DOM images in Node: textures are not carried
async function three(file, out) {
  const buf = fs.readFileSync(file);
  const obj = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), path.dirname(file) + "/");
  const glb = await new GLTFExporter().parseAsync(obj, { binary: true, animations: obj.animations, onlyVisible: false });
  fs.writeFileSync(out, Buffer.from(glb));
}

const tools = { assimp, fbx2gltf, three };
const rows = [];
for (const f of fs.readdirSync(IN).filter((x) => /\.fbx$/i.test(x))) {
  for (const [name, fn] of Object.entries(tools)) {
    const out = path.join(OUT, `${path.basename(f, ".fbx").replace(/\s+/g, "_")}.${name}.glb`);
    const row = { file: f, tool: name };
    const t0 = performance.now();
    try {
      await fn(path.join(IN, f), out);
      row.ms = Math.round(performance.now() - t0);
      const data = new Uint8Array(fs.readFileSync(out));
      row.kb = Math.round(data.length / 1024);
      const rep = await validator.validateBytes(data, { maxIssues: 200 });
      row.errors = rep.issues.numErrors;
      row.warnings = rep.issues.numWarnings;
      const info = rep.info ?? {};
      Object.assign(row, { meshes: info.meshCount ?? 0, materials: info.materialCount ?? 0, textures: info.textureCount ?? 0, nodes: info.nodeCount ?? 0, animations: info.animationCount ?? 0, skins: info.skinCount ?? 0, tris: info.totalTriangleCount ?? 0 });
      row.firstError = rep.issues.messages.find((m) => m.severity === 0)?.code;
    } catch (e) {
      row.ms = Math.round(performance.now() - t0);
      row.fail = String(e.message ?? e).split("\n")[0].slice(0, 120);
    }
    rows.push(row);
    console.error(JSON.stringify(row));
  }
}
fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(rows, null, 1));
