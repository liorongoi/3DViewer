// WP 4.4 and 4.6 check (UPL-04, UPL-05), in the web app against the real server.
//
//   - The top bar lists the open model's versions with their dates and notes, the current one marked.
//   - Choosing an earlier version opens it from the same viewpoint, the badge says which of how
//     many is shown, and the audit log records the version opened.
//   - The Properties tab edits the library's details: the change is saved for everyone, shown at
//     once, and recorded with each field's old and new value; the classification set there is
//     the library's too, and a choice kept on one workstation does not mark a server model.
//   - A share link opens the version it was made on, with its measurements (WP 4.6).
//
// The check starts its own server (apps/server built, on :8787, with an empty database and the
// sample library) behind the web app's `vite preview` on :4173, which passes /api to it.
// Usage: build apps/web and apps/server, start `vite preview` on :4173, then
// node scripts/check-versions.cjs (CHROMIUM may point at a Chromium binary).
const { chromium } = require("playwright");
const { startServer } = require("./lib/test-server.cjs");
const { describeFailure, watchConsole } = require("./lib/page-diagnostics.cjs");

(async () => {
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` (${detail})` : ""}`);
    if (!ok) failed++;
  };

  const { api, audit: auditOf, stop } = await startServer();
  const audit = (action) => auditOf("m-lantern", action);

  // The lantern has three versions of the same file. A fourth replaces it with the boom box, so
  // the version shown can be told apart from the shape drawn.
  const boombox = await api("GET", "/api/models/m-boombox");
  await api("POST", "/api/models/m-lantern/versions", { source: boombox.source, note: "Replaced with the boom box for the check" });
  const before = await api("GET", "/api/models/m-lantern");

  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  await ctx.addInitScript(() => {
    localStorage.setItem("viewer.lang", "en");
    localStorage.setItem("viewer.fadeTools", "false");
    // The app's low quality: software rendering on CI takes seconds a frame at full quality.
    localStorage.setItem("viewer.quality", "low");
    // A classification chosen on this workstation earlier: it must not mark a server model.
    localStorage.setItem("viewer.classOverrides", JSON.stringify({ "m-lantern": "unclassified" }));
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  watchConsole(page, "versions");
  try {
    await page.goto("http://localhost:4173/", { waitUntil: "load" });
    await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 120000 });
    await page.getByRole("button", { name: /Lantern/ }).first().click({ timeout: 60000 });
    // Ready, and the flight to it over.
    await page.waitForFunction(() => window.viewerEngine.model?.ready && window.viewerEngine.current.get()?.id === "m-lantern" && !window.viewerEngine.loading.get(), null, { timeout: 120000 });
    let cur = await page.evaluate(() => window.viewerEngine.current.get());
    check(cur.version === 4 && /BoomBox/.test(cur.source.url), "the library opens the current version", `v${cur.version}, ${cur.source.url.split("/").pop()}`);

    // ---- The version list ----
    const picker = page.getByTestId("version-picker");
    check((await picker.innerText()).trim() === "v4", "the top bar shows the version", await picker.innerText());
    await picker.click();
    const items = page.getByRole("menuitemradio");
    await items.first().waitFor({ timeout: 20000 });
    const rows = await items.evaluateAll((els) => els.map((el) => ({ v: Number(el.dataset.version), on: el.getAttribute("aria-checked") === "true", text: el.innerText })));
    check(rows.map((r) => r.v).join() === "4,3,2,1", "it lists every version, newest first", rows.map((r) => r.v).join(", "));
    check(rows[0].on && rows.filter((r) => r.on).length === 1 && /Current/i.test(rows[0].text), "the one shown is checked and the current one is marked");
    check(rows[0].text.includes("Replaced with the boom box for the check") && /No note/.test(rows[1].text), "each shows its note");
    const dateShown = new Date(before.history[0].createdAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
    check(rows[0].text.includes(dateShown), "and its date", dateShown);

    // ---- An earlier version, from the same viewpoint ----
    const view = await page.evaluate(() => window.viewerEngine.getView());
    const views = (await audit("model.view")).length;
    await page.locator('[role=menuitemradio][data-version="3"]').click();
    await page.waitForFunction(() => window.viewerEngine.current.get()?.version === 3 && window.viewerEngine.model?.ready && !window.viewerEngine.loading.get(), null, { timeout: 120000 });
    await page.waitForTimeout(300);
    cur = await page.evaluate(() => window.viewerEngine.current.get());
    check(/Lantern/.test(cur.source.url), "choosing version 3 opens its own file", cur.source.url.split("/").pop());
    const after = await page.evaluate(() => window.viewerEngine.getView());
    const moved = Math.max(Math.abs(after.lon - view.lon) * 111000, Math.abs(after.lat - view.lat) * 111000, Math.abs(after.h - view.h), Math.abs(after.heading - view.heading) * 1000);
    check(moved < 0.01, "from the same viewpoint", `${moved.toFixed(4)} m`);
    check((await picker.innerText()).trim() === "v3 of 4", "the badge says an earlier version is shown", await picker.innerText());
    check(!(await page.getByRole("menu").isVisible().catch(() => false)), "the list closes");
    const opened = (await audit("model.view")).slice(0, (await audit("model.view")).length - views);
    check(opened.some((e) => e.detail?.version === 3), "the audit log records version 3 opened", JSON.stringify(opened.map((e) => e.detail)));

    // ---- Editing the details ----
    if (!(await page.getByRole("tab", { name: "Properties" }).isVisible().catch(() => false))) await page.keyboard.press(".");
    await page.getByRole("tab", { name: "Properties" }).click();
    const props = page.getByTestId("properties");
    await props.waitFor({ timeout: 20000 });
    const clsSelect = props.getByRole("combobox", { name: "Classification of this model" });
    check((await clsSelect.inputValue()) === before.classificationId, "a choice kept on this workstation does not mark a server model", `${await clsSelect.inputValue()}, library ${before.classificationId}`);
    await props.getByRole("button", { name: "Edit details" }).click();
    const form = page.getByTestId("details-form");
    await form.getByLabel("Model name *").fill("Lantern, edited in the viewer");
    await form.getByLabel("Project name").fill("Old City survey 2027");
    await form.getByLabel("Update status").selectOption("current");
    await form.getByLabel("Description").fill("Edited by the check.\nSecond line.");
    const updates = (await audit("model.update")).length;
    await form.getByRole("button", { name: "Save" }).click();
    await form.waitFor({ state: "detached", timeout: 20000 });
    const saved = await api("GET", "/api/models/m-lantern");
    check(saved.name === "Lantern, edited in the viewer" && saved.project === "Old City survey 2027" && saved.status === "current" && saved.description === "Edited by the check.\nSecond line.", "the details are saved to the library", `${saved.name} · ${saved.project} · ${saved.status}`);
    check(saved.operation === before.operation && saved.responsibleEntity === before.responsibleEntity, "fields left alone are unchanged");
    await page.waitForFunction(() => document.body.innerText.includes("Lantern, edited in the viewer"), null, { timeout: 10000 }).catch(() => undefined);
    cur = await page.evaluate(() => window.viewerEngine.current.get());
    check(cur.name === saved.name && cur.status === "current" && cur.version === 3, "and shown at once on the version that is open", `${cur.name}, v${cur.version}`);
    const changes = (await audit("model.update")).slice(0, (await audit("model.update")).length - updates);
    const c = changes[0]?.detail?.changes ?? {};
    check(changes.length === 1 && c.name?.[1] === saved.name && c.name?.[0] === before.name && c.project && c.status && c.description && !c.operation, "the audit log records each changed field, old and new", Object.keys(c).join(", "));

    // ---- The classification, for everyone ----
    const levels = await api("GET", "/api/classifications");
    const other = levels.find((l) => l.id !== saved.classificationId).id;
    await clsSelect.selectOption(other);
    let after2 = saved;
    for (let i = 0; i < 40 && after2.classificationId !== other; i++) {
      await page.waitForTimeout(250);
      after2 = await api("GET", "/api/models/m-lantern");
    }
    check(after2.classificationId === other, "the classification chosen in Properties is the library's", `${saved.classificationId} to ${after2.classificationId}`);

    // ---- A share link opens its version, with the measurements on screen ----
    const made = await page.evaluate(() => {
      const e = window.viewerEngine;
      const bs = e.model.boundingSphere;
      const C = bs.center;
      const r = bs.radius;
      const at = (dx, dy, dz) => ({ x: C.x + dx, y: C.y + dy, z: C.z + dz });
      e.measure.start("distance");
      e.measure.addPoint(at(-r / 2, 0, 0));
      e.measure.addPoint(at(r / 2, r / 3, 0));
      e.measure.start("path");
      e.measure.addPoint(at(0, 0, -r / 2));
      e.measure.addPoint(at(0, r / 4, 0));
      e.measure.addPoint(at(r / 5, r / 4, r / 2));
      e.measure.finish();
      e.measure.cancel();
      const [d, p] = e.measure.measurements.get();
      e.measure.rename(p.id, "Fence line, שורת גדר");
      e.measure.setVisible(d.id, false);
      return e.measure.measurements.get().map((m) => ({ kind: m.kind, label: m.label, visible: m.visible, total: m.result.total3d }));
    });
    await page.getByRole("button", { name: "Share view" }).click();
    await page.waitForFunction(() => location.hash.startsWith("#view="), null, { timeout: 10000 });
    const link = await page.evaluate(() => location.href);
    const other2 = await ctx.newPage();
    other2.on("pageerror", (e) => errors.push(e.message));
    watchConsole(other2, "versions, second page");
    await other2.goto(link, { waitUntil: "load" });
    await other2.waitForFunction(() => window.viewerEngine?.model?.ready && window.viewerEngine.current.get()?.id === "m-lantern", null, { timeout: 120000 });
    const shared = await other2.evaluate(() => window.viewerEngine.current.get());
    check(shared.version === 3 && /Lantern/.test(shared.source.url), "a share link made on version 3 opens version 3", `v${shared.version}`);
    check((await other2.getByTestId("version-picker").innerText()).trim() === "v3 of 4", "and says so");
    const got = await other2.evaluate(() => window.viewerEngine.measure.measurements.get().map((m) => ({ kind: m.kind, label: m.label, visible: m.visible, total: m.result.total3d })));
    const same = made.every((m) => m.total > 0.01) && got.length === made.length && got.every((g, i) => g.kind === made[i].kind && g.label === made[i].label && g.visible === made[i].visible && Math.abs(g.total - made[i].total) < 0.002);
    check(made.length === 2 && same, "and brings its measurements: kind, name, hidden or shown, and length to the millimetre", JSON.stringify(got));
    const junk = await other2.evaluate(() => window.viewerEngine.measure.importShared([{ k: "d", n: "x", p: [0, 0, 0, 1, 1, 1] }, { k: "d", p: [1e7, 0, 0, 6.4e6, 0, 0] }, { k: "x", p: [] }, "junk", null, { k: "d", p: [6.4e6, 0, 0, 6.4e6, 1, 0, 6.4e6, 2, 0] }]));
    check(junk === 0, "a link edited to hold points off the earth or of the wrong shape adds nothing", `${junk} added`);
    await other2.close();

    // ---- Back to the current version ----
    await picker.click();
    await page.locator('[role=menuitemradio][data-version="4"]').click();
    await page.waitForFunction(() => window.viewerEngine.current.get()?.version === 4 && window.viewerEngine.model?.ready, null, { timeout: 120000 });
    check((await picker.innerText()).trim() === "v4", "choosing the current version again shows it plainly");
  } catch (e) {
    console.error(e);
    failed++;
    await describeFailure(page, "versions");
  }
  check(errors.length === 0, "no page errors", errors.slice(0, 3).join(" | "));
  await browser.close();
  stop();
  console.log(failed ? `${failed} check(s) failed` : "All version and details checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
