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

/** A one-band float GeoTIFF in WGS 84 (EPSG:4326), every cell the same height. Enough for the check. */
function geotiff4326(west, north, cell, w, h, value) {
  const tags = [];
  const extra = [];
  let extraAt = 0;
  const dataAt = 8;
  const dataLen = w * h * 4;
  const put = (buf) => {
    const at = extraAt;
    extra.push(buf);
    extraAt += buf.length;
    return at;
  };
  const doubles = (a) => { const b = Buffer.alloc(a.length * 8); a.forEach((v, i) => b.writeDoubleLE(v, i * 8)); return b; };
  const shorts = (a) => { const b = Buffer.alloc(a.length * 2); a.forEach((v, i) => b.writeUInt16LE(v, i * 2)); return b; };
  const scale = put(doubles([cell, cell, 0]));
  const tie = put(doubles([0, 0, 0, west, north, 0]));
  const keys = put(shorts([1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, 1, 2048, 0, 1, 4326]));
  const nodata = put(Buffer.from("-9999\0", "latin1"));
  const entries = [
    [256, 3, 1, w], [257, 3, 1, h], [258, 3, 1, 32], [259, 3, 1, 1], [262, 3, 1, 1], [273, 4, 1, dataAt], [277, 3, 1, 1], [278, 3, 1, h], [279, 4, 1, dataLen], [339, 3, 1, 3],
    [33550, 12, 3, -scale - 1], [33922, 12, 6, -tie - 1], [34735, 3, 16, -keys - 1], [42113, 2, 6, -nodata - 1],
  ];
  const ifdAt = dataAt + dataLen;
  const extraBase = ifdAt + 2 + entries.length * 12 + 4;
  const ifd = Buffer.alloc(2 + entries.length * 12 + 4);
  ifd.writeUInt16LE(entries.length, 0);
  entries.forEach(([tag, type, count, v], k) => {
    const e = 2 + k * 12;
    ifd.writeUInt16LE(tag, e);
    ifd.writeUInt16LE(type, e + 2);
    ifd.writeUInt32LE(count, e + 4);
    if (v < 0) ifd.writeUInt32LE(extraBase - v - 1, e + 8);
    else if (type === 3) ifd.writeUInt16LE(v, e + 8);
    else ifd.writeUInt32LE(v, e + 8);
  });
  const head = Buffer.alloc(8);
  head.write("II", 0, "latin1");
  head.writeUInt16LE(42, 2);
  head.writeUInt32LE(ifdAt, 4);
  const data = Buffer.alloc(dataLen);
  for (let i = 0; i < w * h; i++) data.writeFloatLE(value, i * 4);
  return Buffer.concat([head, data, ifd, ...extra]);
}

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

  // Heights against a DSM (SRS GS-06): a GeoTIFF in WGS 84 around the model, one metre below its base.
  const place = await page.evaluate(() => window.viewerEngine.current.get().placement);
  const tifPath = path.join(out, "reference-dsm.tif");
  fs.writeFileSync(tifPath, geotiff4326(place.lon - 0.0003, place.lat + 0.0003, 0.00001, 60, 60, place.height - 1));
  const sp = page.getByTestId("splat-panel");
  await sp.getByTestId("elev-open").click();
  await sp.getByTestId("elev-file").setInputFiles(tifPath);
  await sp.getByTestId("elev-run").click();
  const elev = page.getByTestId("elev-result").or(sp.getByRole("alert"));
  await elev.first().waitFor({ timeout: 60000 });
  const elevText = await elev.first().innerText();
  check(/Cells compared/.test(elevText), `heights compared with a DSM (${elevText.replace(/\s+/g, " ").slice(0, 200)})`);
  await page.screenshot({ path: path.join(out, "8b-elevation.png") });

  // A presentation video (SRS GS-24): 4 seconds, played back outside HOLO with ffprobe/ffmpeg.
  // A software GPU draws a full window slowly: draw the frames small (they are scaled to the video's size).
  await page.setViewportSize({ width: 800, height: 450 });
  await page.getByTestId("video-open").click();
  await page.getByTestId("video-seconds").selectOption("4");
  const [vid] = await Promise.all([page.waitForEvent("download", { timeout: 300000 }), page.getByTestId("video-make").click()]);
  const mp4 = path.join(out, vid.suggestedFilename());
  await vid.saveAs(mp4);
  const { execFileSync } = require("child_process");
  try {
    const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=width,height,codec_name,nb_read_frames,avg_frame_rate:format=duration", "-of", "json", mp4]).toString());
    const st = probe.streams[0];
    check(st.width === 1280 && st.height === 720 && Number(st.nb_read_frames) === 120 && Math.abs(Number(probe.format.duration) - 4) < 0.1, `the MP4 plays outside HOLO: ${st.codec_name} ${st.width}x${st.height}, ${st.nb_read_frames} frames, ${Number(probe.format.duration).toFixed(2)} s`);
    const gray = execFileSync("ffmpeg", ["-v", "error", "-i", mp4, "-vf", "scale=32:18,format=gray", "-f", "rawvideo", "-"], { maxBuffer: 1 << 26 });
    let blank = 0;
    for (let f = 0; f < gray.length / 576; f++) {
      const px = gray.subarray(f * 576, (f + 1) * 576);
      const mean = px.reduce((a, b) => a + b, 0) / 576;
      const sd = Math.sqrt(px.reduce((a, b) => a + (b - mean) ** 2, 0) / 576);
      if (sd < 1.5) blank++;
    }
    check(blank === 0, `no blank frames (${blank} of ${gray.length / 576})`);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", mp4, "-vf", "select=eq(n\\,0)+eq(n\\,60),scale=640:-2,tile=2x1", "-frames:v", "1", path.join(out, "10-video-frames.png")]);
  } catch (e) {
    check(false, `ffprobe/ffmpeg could read the video (${e.message.slice(0, 200)})`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });

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
