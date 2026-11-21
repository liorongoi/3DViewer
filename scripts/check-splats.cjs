// Gaussian splat acceptance in a real browser (docs/GAUSSIAN_SPLATS.md, SRS GS-11, GS-15, GS-18):
// a splat file goes through the upload wizard, is scaled from one real measurement (or left
// floating), opens as 3D Tiles drawn by Cesium, and is framed without floaters. Screenshots are
// written for a person to look at; the script itself checks what it can read back.
//
// Usage: build apps/web, start `vite preview` on :4173 (and the server, for --server), then
//   node scripts/check-splats.cjs [out folder] [file.ply|file.spz]
// Without a file it makes a synthetic cloud: a 2 × 1 × 3 unit box of coloured splats with a
// few floaters 500 units away, so framing and scaling can be checked exactly.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "splat-check-"));
const given = process.argv[3];
fs.mkdirSync(out, { recursive: true });

/** A trainer-style PLY (COLMAP frame: y down): a box of splats, its base at y = 0 (so −y is up). */
function syntheticPly() {
  const props = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
  const rows = [];
  const C0 = 0.28209479177387814;
  for (let i = 0; i <= 20; i++)
    for (let j = 0; j <= 30; j++)
      for (const [x, y, z] of [[i / 10, -j / 10, 0], [i / 10, -j / 10, 1], [0, -j / 10, i / 20], [2, -j / 10, i / 20]]) {
        // Red to blue up the height, so up and down are visible in a screenshot.
        const t = j / 30;
        rows.push([x, y, z, (1 - t - 0.5) / C0, (0.3 - 0.5) / C0, (t - 0.5) / C0, 4, -3.2, -3.2, -3.2, 1, 0, 0, 0]);
      }
  for (let k = 0; k < 5; k++) rows.push([500 + k, -500, 500, 0, 0, 0, 4, -2, -2, -2, 1, 0, 0, 0]);
  const head = Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex ${rows.length}\n${props.map((p) => `property float ${p}`).join("\n")}\nend_header\n`);
  const body = Buffer.alloc(rows.length * props.length * 4);
  rows.forEach((r, i) => r.forEach((v, k) => body.writeFloatLE(v, (i * props.length + k) * 4)));
  return { name: "synthetic-box.ply", buffer: Buffer.concat([head, body]), mimeType: "application/octet-stream" };
}

let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
};

(async () => {
  const file = given ? { name: path.basename(given), buffer: fs.readFileSync(given), mimeType: "application/octet-stream" } : syntheticPly();
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || undefined,
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4173/", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });

  for (const run of [{ mode: "known", metres: "6" }, { mode: "floating" }]) {
    const dialog = page.getByRole("dialog", { name: "Upload a model" });
    const button = page.getByRole("button", { name: "Upload model" }).first();
    if (await button.isVisible()) await button.click();
    else {
      await page.keyboard.press("Control+k");
      await page.getByRole("option", { name: "Upload model" }).click();
    }
    await dialog.locator('input[type="file"]').first().setInputFiles(file);
    await dialog.getByTestId("upload-report").waitFor({ timeout: 60000 });
    const report = await dialog.getByTestId("upload-report").innerText();
    check(/Gaussian splats/.test(report), `${run.mode}: the check names the file as Gaussian splats`);
    if (run.mode === "known") await page.screenshot({ path: path.join(out, "1-check.png") });
    const next = dialog.getByRole("button", { name: "Next" });
    await next.click();
    check(await dialog.getByTestId("size-floating").getAttribute("aria-checked") === "true", `${run.mode}: a splat model starts floating`);
    if (run.mode === "known") {
      await dialog.getByTestId("size-known").click();
      await dialog.getByTestId("known-side").selectOption("h");
      await dialog.getByTestId("known-metres").fill(run.metres);
      const res = await dialog.getByTestId("known-result").innerText();
      check(!given ? /6\.00 m|× 6\.00/.test(res) : true, `known: the step shows the scaled size (${res.trim()})`);
      await page.screenshot({ path: path.join(out, "2-place-known.png") });
    } else await page.screenshot({ path: path.join(out, "2-place-floating.png") });
    await next.click();
    await next.click();
    await dialog.locator("select.font-semibold").selectOption({ index: 1 });
    const before = await page.evaluate(() => window.viewerEngine.current.get()?.id ?? null);
    await dialog.getByRole("button", { name: "Publish" }).click();
    await dialog.waitFor({ state: "detached", timeout: 60000 });
    await page.waitForFunction((id) => {
      const e = window.viewerEngine;
      return e.current.get()?.id !== id && e.tileset && !e.loading.get();
    }, before, { timeout: 120000 });
    // Decoded and sorted off the main thread: wait until the sort is committed, then let the view settle.
    const t0 = Date.now();
    await page.waitForFunction(() => {
      const t = window.viewerEngine.tileset;
      const p = t.gaussianSplatPrimitive;
      return t.tilesLoaded && p && p._hasGaussianSplatTexture && !p._sorterState && !p._dirty;
    }, null, { timeout: 120000, polling: 200 });
    const ms = Date.now() - t0;
    await page.waitForTimeout(3000);
    const got = await page.evaluate(() => {
      const e = window.viewerEngine;
      const m = e.current.get();
      const bs = e.boundingSphere();
      return { splats: !!m.source.splats, placement: m.placement, radius: bs.radius, full: e.tileset.boundingSphere.radius, error: e.error.get() };
    });
    check(got.splats && !got.error, `${run.mode}: opened as splats without an error ${got.error ? JSON.stringify(got.error) : ""}`);
    console.log(`      decoded and sorted ${ms} ms after the tileset opened (software GL here; a GPU is far faster)`);
    if (!given) {
      // The box is 2 × 3 × 1 units: half its diagonal is 1.87 units. Height 3 units → 6 m doubles it.
      const k = run.mode === "known" ? 2 : 1;
      check(Math.abs(got.radius - 1.87 * k) < 0.35 * k, `${run.mode}: framed on the box, not the floaters (radius ${got.radius.toFixed(2)}, all splats ${got.full.toFixed(0)})`);
      check(run.mode === "known" ? Math.abs(got.placement.scale - 2) < 0.05 && !got.placement.modelUnit : got.placement.modelUnit === 1, `${run.mode}: placement ${JSON.stringify({ scale: got.placement.scale, modelUnit: got.placement.modelUnit })}`);
    }
    await page.screenshot({ path: path.join(out, `3-open-${run.mode}.png`) });
  }
  check(errors.length === 0, `no page errors ${errors.slice(0, 3).join(" | ")}`);
  await browser.close();
  console.log(`Screenshots in ${out}`);
  process.exit(failures ? 1 : 0);
})();
