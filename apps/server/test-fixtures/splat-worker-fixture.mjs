#!/usr/bin/env node
// TEST FIXTURE, not a reconstruction: stands in for a splat training worker in tests
// (apps/server/src/reconstruct.ts, worker contract). It checks its arguments the way a real
// worker must receive them, counts the input pictures, and writes a small box of splats with a
// provenance file that says it is a fixture, so its output is labelled everywhere it appears.
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
// The component check (splat-components.ts): a fixture says so.
if (args[0] === "--check") {
  console.log(JSON.stringify({ ok: true, tool: "holo-test-fixture", version: "1", revision: "test-fixture", problems: [], fixture: true }));
  process.exit(0);
}
// The capture check (--assess): a fixed report that says it is a fixture.
if (args[0] === "--assess") {
  const out = args[args.indexOf("--output") + 1];
  const input = args[args.indexOf("--input") + 1];
  const names = readdirSync(input, { recursive: true }).map(String);
  const bad = names.some((f) => /blurred/.test(f));
  const items = [bad ? { key: "blurry", severity: "error", params: { share: 60, when: "0:01–0:09" } } : { key: "posesGood", severity: "ok", params: { posed: 2, total: 2, share: 100 } }, { key: "fixture", severity: "info", params: {} }];
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, "report.json"), JSON.stringify({ verdict: bad ? "poor" : "good", items, stats: { fixture: 1 } }));
  console.log("progress 1 done");
  process.exit(0);
}
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
// A capture with a picture named slow* trains for two minutes, so a test can cancel it.
if (pictures.some((f) => /^slow/.test(f))) {
  console.log("progress 0.2 train");
  await new Promise((r) => setTimeout(r, 120_000));
}
console.log("progress 0.6 train");

const props = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
const rows = [];
for (let i = 0; i <= 10; i++) for (let j = 0; j <= 10; j++) rows.push([i / 10, -j / 10, 0, 0.5, 0, -0.5, 3, -3, -3, -3, 1, 0, 0, 0]);
const head = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${rows.length}\n${props.map((p) => `property float ${p}`).join("\n")}\nend_header\n`);
const body = Buffer.alloc(rows.length * props.length * 4);
rows.forEach((r, i) => r.forEach((v, k) => body.writeFloatLE(v, (i * props.length + k) * 4)));
mkdirSync(opt("output"), { recursive: true });
writeFileSync(path.join(opt("output"), "splats.ply"), Buffer.concat([head, body]));
writeFileSync(path.join(opt("output"), "provenance.json"), JSON.stringify({ tool: "holo-test-fixture", version: "1", poses: "none (fixture)", frames: pictures.length, registeredViews: 0, fixture: true, args }));
// A capture with a picture named gps* stands for one whose camera positions placed it (georef.json).
if (pictures.some((f) => /^gps/.test(f)))
  writeFileSync(
    path.join(opt("output"), "georef.json"),
    JSON.stringify({ frame: "enu", origin: { lat: 31.7683, lon: 35.2137, height: 780.5 }, source: "photo EXIF GPS", horizontalCrs: "EPSG:4326", verticalDatum: "as recorded by the camera", metresPerModelUnit: 2.5, controls: { count: 16, horizontalRms: 1.2, verticalRms: 2.4, max: 4.1 }, checks: { count: 4, horizontalRms: 1.5, verticalRms: 2.9, max: 4.4 } }),
  );
console.log("progress 1 done");
