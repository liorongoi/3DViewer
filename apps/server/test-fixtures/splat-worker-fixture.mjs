#!/usr/bin/env node
// TEST FIXTURE, not a reconstruction: stands in for a splat training worker in tests
// (apps/server/src/reconstruct.ts, worker contract). It checks its arguments the way a real
// worker must receive them, counts the input pictures, and writes a small box of splats with a
// provenance file that says it is a fixture, so its output is labelled everywhere it appears.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const opt = (k) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
for (const k of ["method", "input", "input-kind", "goal", "output", "preset", "iterations", "max-splats", "resolution", "sh-degree", "video-fps", "threads"])
  if (opt(k) === undefined) {
    console.error(`missing --${k}`);
    process.exit(1);
  }
const list = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? list(path.join(d, e.name)) : [e.name]));
const pictures = list(opt("input")).filter((f) => /\.(jpe?g|png|tiff?|mp4|mov)$/i.test(f));
if (pictures.length === 0) {
  console.error("no pictures");
  process.exit(2);
}
if (pictures.some((f) => /^unusable/.test(f))) {
  console.error("too few matching features between the images");
  process.exit(2);
}
console.log("progress 0.1 poses");
console.log("progress 0.6 train");

const props = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
const rows = [];
for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) rows.push([i / 10, -j / 10, 0, 0.5, 0, -0.5, 3, -3, -3, -3, 1, 0, 0, 0]);
const head = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${rows.length}\n${props.map((p) => `property float ${p}`).join("\n")}\nend_header\n`);
const body = Buffer.alloc(rows.length * props.length * 4);
rows.forEach((r, i) => r.forEach((v, k) => body.writeFloatLE(v, (i * props.length + k) * 4)));
mkdirSync(opt("output"), { recursive: true });
writeFileSync(path.join(opt("output"), "splats.ply"), Buffer.concat([head, body]));
writeFileSync(path.join(opt("output"), "provenance.json"), JSON.stringify({ tool: "holo-test-fixture", version: "1", poses: "none (fixture)", fixture: true, args }));
console.log("progress 1 done");
