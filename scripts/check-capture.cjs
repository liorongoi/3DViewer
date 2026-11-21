// "Make a splat" in a real browser (docs/GAUSSIAN_SPLATS.md, "Making a splat"): the wizard sends
// photos to the server, the recommended method trains, and the result opens. Needs the server
// with a worker installed, e.g. the labelled TEST FIXTURE worker:
//   SPLAT_WORKERS=opensplat=$PWD/apps/server/test-fixtures/splat-worker-fixture.mjs node apps/server/dist/main.js
// and the web app built with VITE_API_URL pointing at it, on vite preview :4173. Then
//   node scripts/check-capture.cjs [out folder]
const fs = require("fs");
const os = require("os");
const path = require("path");
const { chromium } = require("playwright");

const out = process.argv[2] || fs.mkdtempSync(path.join(os.tmpdir(), "capture-check-"));
fs.mkdirSync(out, { recursive: true });
let failures = 0;
const check = (ok, what) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
};

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("http://localhost:4173/", { waitUntil: "load" });
  await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });
  await page.waitForTimeout(1500);

  const opener = page.getByTestId("open-capture");
  if (await opener.isVisible()) await opener.click();
  else {
    await page.keyboard.press("Control+k");
    await page.getByRole("option", { name: /Make a splat/ }).click();
  }
  const dialog = page.getByRole("dialog", { name: "Make a splat" });
  await dialog.waitFor();
  await dialog.getByTestId("capture-input-photos").click();
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
  await dialog.getByTestId("capture-files").setInputFiles([
    { name: "IMG_0001.jpg", mimeType: "image/jpeg", buffer: jpg },
    { name: "IMG_0002.jpg", mimeType: "image/jpeg", buffer: jpg },
    { name: "IMG_0003.jpg", mimeType: "image/jpeg", buffer: jpg },
  ]);
  check((await dialog.getByTestId("capture-chosen").innerText()).includes("3"), "three photos chosen");
  await page.screenshot({ path: path.join(out, "1-have.png") });
  await dialog.getByTestId("capture-next").click();
  await dialog.getByTestId("capture-goal-scene").click();
  await page.screenshot({ path: path.join(out, "2-want.png") });
  await dialog.getByTestId("capture-next").click();
  await dialog.getByTestId("capture-recommendation").waitFor();
  const rec = await dialog.getByTestId("capture-recommendation").innerText();
  check(/OpenSplat/.test(rec), `recommends the method that runs here (${rec.replace(/\s+/g, " ").slice(0, 120)})`);
  check(/processor/.test(rec), "says why: no graphics card here");
  check((await dialog.getByTestId("preset-fast").getAttribute("aria-checked")) === "true", "a CPU-only server starts on Fast");
  await dialog.getByTestId("capture-setup").locator("summary").click();
  const setupText = await dialog.getByTestId("setup-opensplat").innerText();
  check(/Connected to HOLO/.test(setupText) && /test worker/.test(setupText), `install states shown, the test worker labelled (${setupText.replace(/\s+/g, " ").slice(0, 140)})`);
  await page.screenshot({ path: path.join(out, "3-how.png") });
  await dialog.getByTestId("capture-next").click();
  await dialog.getByTestId("capture-name").fill("Courtyard test");
  await dialog.getByTestId("capture-class").selectOption({ index: 1 });
  await page.screenshot({ path: path.join(out, "4-details.png") });
  await dialog.getByTestId("capture-start").click();
  await dialog.getByTestId("capture-progress").waitFor({ timeout: 60000 });
  await dialog.getByRole("button", { name: "Open it" }).waitFor({ timeout: 180000 });
  await page.screenshot({ path: path.join(out, "5-done.png") });
  await dialog.getByRole("button", { name: "Open it" }).click();
  await page.waitForFunction(() => {
    const e = window.viewerEngine;
    const t = e.tileset;
    return e.current.get()?.source?.splats && t && t.tilesLoaded && t.gaussianSplatPrimitive?._hasGaussianSplatTexture && !e.loading.get();
  }, null, { timeout: 180000, polling: 300 });
  await page.waitForTimeout(3000);
  const m = await page.evaluate(() => window.viewerEngine.current.get());
  check(m.name === "Courtyard test" && m.placement.modelUnit === 1, `opens as a floating splat model (${m.name}, modelUnit ${m.placement.modelUnit})`);
  await page.screenshot({ path: path.join(out, "6-open.png") });

  // Give it a real size afterwards: a new version with the same files.
  const props = page.getByRole("tab", { name: "Properties" });
  if (!(await props.isVisible())) await page.keyboard.press(".");
  await page.getByRole("tab", { name: "Properties" }).click();
  const panel = page.getByTestId("splat-panel");
  await panel.waitFor();
  check(/Floating/.test(await panel.getByTestId("splat-size").innerText()), "Properties say the model is floating");
  for (const [id, ext] of [["splat-dl-tiles", ".zip"], ["splat-dl-spz", ".spz"], ["splat-dl-original", ".ply"]]) {
    const [dl] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), panel.getByTestId(id).click()]);
    const file = path.join(out, `floating-${dl.suggestedFilename()}`);
    await dl.saveAs(file);
    check(dl.suggestedFilename().endsWith(ext) && fs.statSync(file).size > 100, `floating download ${dl.suggestedFilename()} (${fs.statSync(file).size} bytes)`);
  }
  await panel.getByTestId("splat-set-size").click();
  await panel.getByTestId("known-side").selectOption("w");
  await panel.getByTestId("known-metres").fill("5");
  await page.screenshot({ path: path.join(out, "7-set-size.png") });
  await panel.getByTestId("splat-size-save").click();
  await page.waitForFunction(() => window.viewerEngine.current.get()?.version === 2 && !window.viewerEngine.loading.get(), null, { timeout: 120000 });
  const m2 = await page.evaluate(() => window.viewerEngine.current.get());
  check(m2.placement.modelUnit === undefined && Math.abs(m2.placement.scale - 5) < 0.3, `the new version has a real size (scale ${m2.placement.scale.toFixed(3)} m per unit)`);
  await page.getByTestId("splat-panel").waitFor();
  const [dl2] = await Promise.all([page.waitForEvent("download", { timeout: 60000 }), page.getByTestId("splat-panel").getByTestId("splat-dl-spz").click()]);
  check(dl2.suggestedFilename().endsWith("-spz.zip"), `a sized SPZ comes with its position (${dl2.suggestedFilename()})`);
  await dl2.saveAs(path.join(out, `sized-${dl2.suggestedFilename()}`));
  await page.waitForTimeout(2000);
  await page.screenshot({ path: path.join(out, "8-sized.png") });

  // Side by side: the sized version on the left, the floating first version on the right.
  await page.getByTestId("splat-panel").getByTestId("compare-pick").selectOption("1");
  await page.getByTestId("compare-overlay").waitFor({ timeout: 60000 });
  const left = await page.getByTestId("compare-left").innerText();
  const right = await page.getByTestId("compare-right").innerText();
  check(/v2/.test(left) && /v1/.test(right) && /Made with OpenSplat/.test(right), `side by side names each version and how it was made (${left.replace(/\s+/g, " ")} | ${right.replace(/\s+/g, " ")})`);
  const handle = page.getByTestId("compare-handle");
  const box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(1440 * 0.3, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  const split = await page.evaluate(() => window.viewerEngine.widget.scene.splitPosition);
  check(Math.abs(split - 0.3) < 0.03, `the divider follows the drag (${split.toFixed(2)})`);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(out, "9-side-by-side.png") });
  await page.getByTestId("compare-stop").click();
  const freed = await page.evaluate(() => window.viewerEngine.widget.scene.primitives.length);
  check(!(await page.getByTestId("compare-overlay").isVisible()) && freed >= 1, "stopping removes the compared model");
  check(errors.length === 0, `no page errors ${errors.slice(0, 3).join(" | ")}`);
  await browser.close();
  console.log(`Screenshots in ${out}`);
  process.exit(failures ? 1 : 0);
})();
