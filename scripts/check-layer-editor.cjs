// WP 4.3 check (UPL-09): the producer's layer editor, in the web app against the real server,
// on the chess set (49 named parts).
//
//   - The editor starts from the layers the panel shows.
//   - Rename, merge, a new group filled by dragging a part into it, move down: saved, the panel
//     shows the new arrangement, a merged layer shows and hides all its parts in 3D, and the
//     audit log records the change.
//   - The next version starts from the arrangement (the manifest round-trips across versions).
//   - The standard names are suggested; Cancel keeps what was saved; "Back to the file's own
//     layers" clears it.
//   - An earlier version cannot be arranged (it keeps its own arrangement).
//   - The upload wizard's Layers step saves its suggested standard names when the model is published.
//
// Usage: build apps/web and apps/server, start `vite preview` on :4173, then
// node scripts/check-layer-editor.cjs (CHROMIUM may point at a Chromium binary). The check
// starts its own server on :8787.
const { chromium } = require("playwright");
const path = require("node:path");
const { startServer } = require("./lib/test-server.cjs");
const { describeFailure, watchConsole } = require("./lib/page-diagnostics.cjs");

const ROOT = path.resolve(__dirname, "..");

const STANDARD = ["Terrain", "Buildings", "Infrastructure", "Vegetation", "Water", "Other"];

(async () => {
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` (${detail})` : ""}`);
    if (!ok) failed++;
  };
  const { api, audit, stop } = await startServer({ workers: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  await ctx.addInitScript(() => {
    localStorage.setItem("viewer.lang", "en");
    localStorage.setItem("viewer.fadeTools", "false");
    // The app's low quality: software rendering on CI takes seconds a frame at full quality.
    localStorage.setItem("viewer.quality", "low");
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  watchConsole(page, "layer-editor");

  const openChess = async () => {
    await page.goto("http://localhost:4173/", { waitUntil: "load" });
    await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 120000 });
    await page.getByRole("button", { name: /A Beautiful Game/ }).first().click({ timeout: 60000 });
    await page.waitForFunction(() => window.viewerEngine.model?.ready && window.viewerEngine.current.get()?.id === "m-chess" && !window.viewerEngine.loading.get() && window.viewerEngine.layers.get().length > 0, null, { timeout: 120000 });
    // The saved arrangement arrives after the model.
    await page.waitForTimeout(800);
  };
  /** The panel's tree: names and nesting. */
  const panelShape = () =>
    page.getByRole("tree", { name: "Layers" }).evaluate((ul) => {
      const rec = (list) => [...list.querySelectorAll(":scope > li")].map((li) => {
        const kids = li.querySelector(":scope > ul");
        const name = li.querySelector(":scope > div > span[data-content]").textContent;
        return kids ? [name, rec(kids)] : [name];
      });
      return rec(ul);
    });
  const editor = page.getByTestId("layer-editor");
  const editorTop = () => editor.getByRole("tree").evaluate((ul) => [...ul.querySelectorAll(":scope > li")].map((li) => li.getAttribute("aria-label")));
  const editRow = (name) => editor.locator(`li[aria-label="${name.replace(/"/g, '\\"')}"]`).first();
  const rowButton = (name, label) => editRow(name).locator(":scope > div").getByRole("button", { name: label, exact: true });
  const openEditor = async () => {
    await page.getByRole("button", { name: "Arrange layers" }).click();
    await editor.waitFor({ timeout: 10000 });
  };

  try {
    await openChess();
    const original = await panelShape();
    const derived = await page.evaluate(() => {
      const out = [];
      const rec = (ls) => ls.forEach((l) => (l.node !== undefined && !l.children.length && out.push({ name: l.name, node: l.node }), rec(l.children)));
      rec(window.viewerEngine.layers.get());
      return out;
    });
    // Three parts with names found once in the model, to merge and move.
    const unique = derived.filter((d) => d.name !== original[0][0] && derived.filter((x) => x.name === d.name).length === 1);
    const [A, B, C] = unique;
    check(!!(A && B && C), "the chess set has parts to arrange", `${derived.length} parts`);

    // ---- The editor starts from what the panel shows ----
    await openEditor();
    const top0 = await editorTop();
    check(JSON.stringify(top0) === JSON.stringify(original.map((r) => r[0])), "the editor starts from the layers the panel shows", top0.slice(0, 4).join(", "));

    // ---- Rename, merge, new group, drag, move ----
    const first = top0[0];
    await editRow(first).locator(":scope > div").getByRole("combobox", { name: "Layer name" }).fill("Chess set, renamed");
    await editRow(A.name).locator(":scope > div").getByRole("checkbox").check();
    await editRow(B.name).locator(":scope > div").getByRole("checkbox").check();
    await editor.getByRole("button", { name: "Merge 2" }).click();
    check((await editor.locator(`li[aria-label="${B.name}"]`).count()) === 0, "merging two parts leaves one layer", `${A.name} + ${B.name}`);
    await editor.getByRole("button", { name: "New group" }).click();
    const focused = await page.evaluate(() => document.activeElement?.value);
    check(focused === "New group", "a new group's name is ready to type over", focused);
    await page.keyboard.type("Kings and queens");
    // Drag part C by its handle onto the middle of the group's row: it goes inside.
    const grip = editRow(C.name).locator(":scope > div > [data-grip]");
    await grip.scrollIntoViewIfNeeded();
    await grip.dragTo(editRow("Kings and queens").locator(":scope > div"));
    const inGroup = await editRow("Kings and queens").locator(":scope > ul > li").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
    check(inGroup.length === 1 && inGroup[0] === C.name, "dragging a part onto a group's row puts it in the group", inGroup.join(", "));
    await rowButton("Kings and queens", "Move down").click();
    const top1 = await editorTop();
    check(top1[0] === "Chess set, renamed" && top1[1] === "Kings and queens", "Move down moves it one place", top1.slice(0, 3).join(", "));
    const updates = (await audit("m-chess", "layers.update")).length;
    await editor.getByRole("button", { name: "Save" }).click();
    await editor.waitFor({ state: "detached", timeout: 20000 });

    // ---- Saved and shown ----
    const shown = await panelShape();
    check(shown[0][0] === "Chess set, renamed" && shown[1][0] === "Kings and queens" && JSON.stringify(shown[1][1]) === JSON.stringify([[C.name]]), "the panel shows the new arrangement", `${shown[0][0]}; ${shown[1][0]}: ${shown[1][1]?.map((r) => r[0]).join(", ")}`);
    const saved = (await api("GET", "/api/models/m-chess/layers")).manifest;
    check(saved?.layers?.[0]?.name === "Chess set, renamed" && saved.layers[1].name === "Kings and queens", "the server has it", JSON.stringify(saved?.layers?.slice(0, 2).map((l) => l.name)));
    const merged = await page.evaluate(([a, b]) => {
      let found = null;
      const rec = (ls) => ls.forEach((l) => ((l.nodes ?? []).includes(a) && (l.nodes ?? []).includes(b) && (found = l), rec(l.children)));
      rec(window.viewerEngine.layers.get());
      return found && { id: found.id, name: found.name, nodes: found.nodes };
    }, [A.node, B.node]);
    check(!!merged && merged.name === A.name, "the merged layer stands for both parts", JSON.stringify(merged));
    const drawn = (nodes) => page.evaluate((ns) => ns.map((n) => window.viewerEngine.model.sceneGraph._runtimeNodes[n]?.show !== false), nodes);
    await page.locator(`li[data-layer="${merged.id}"] > div > button:nth-of-type(2)`).click();
    await page.waitForTimeout(200);
    const hidden = await drawn([A.node, B.node]);
    await page.locator(`li[data-layer="${merged.id}"] > div > button:nth-of-type(2)`).click();
    await page.waitForTimeout(200);
    const back = await drawn([A.node, B.node]);
    check(hidden.every((v) => !v) && back.every((v) => v), "its eye hides and shows both parts in 3D", `hidden ${hidden}, shown ${back}`);
    check((await audit("m-chess", "layers.update")).length === updates + 1, "the audit log records the change");

    // ---- The next version starts from it ----
    const detail = await api("GET", "/api/models/m-chess");
    await api("POST", "/api/models/m-chess/versions", { source: detail.source, note: "Same file, new version" });
    const v2 = (await api("GET", "/api/models/m-chess/layers")).manifest;
    check(JSON.stringify(v2) === JSON.stringify(saved), "a new version gets the arrangement (the manifest round-trips across versions)");
    await openChess();
    const again = await panelShape();
    check(JSON.stringify(again) === JSON.stringify(shown) && (await page.evaluate(() => window.viewerEngine.current.get().version)) === 2, "and the panel shows it on the new version", `v2, ${again[1]?.[0]}`);

    // ---- Suggestions, Cancel ----
    await openEditor();
    await editor.getByRole("button", { name: "Apply suggestions" }).click();
    const grouped = await editorTop();
    check(grouped.length > 0 && grouped.every((n) => STANDARD.includes(n)), "Apply suggestions gathers the layers under the standard names", grouped.join(", "));
    const named = await editRow(grouped[0]).locator(":scope > div").getByRole("combobox", { name: "Layer name" }).evaluate((el) => [...(el.list?.options ?? [])].map((o) => o.value));
    check(JSON.stringify(named) === JSON.stringify(STANDARD), "the name field offers the standard names", named.join(", "));
    await editor.getByRole("button", { name: "Cancel" }).click();
    await editor.waitFor({ state: "detached", timeout: 10000 });
    check(JSON.stringify(await panelShape()) === JSON.stringify(shown), "Cancel keeps what was saved");

    // ---- Back to the file's own layers ----
    await openEditor();
    await editor.getByRole("button", { name: "Back to the file's own layers" }).click();
    await editor.waitFor({ state: "detached", timeout: 20000 });
    check(JSON.stringify(await panelShape()) === JSON.stringify(original), "Back to the file's own layers shows the file's tree again");
    check((await api("GET", "/api/models/m-chess/layers")).manifest === null, "and clears the server's arrangement");

    // ---- An earlier version keeps its own ----
    await page.getByTestId("version-picker").click();
    await page.locator('[role=menuitemradio][data-version="1"]').click();
    await page.waitForFunction(() => window.viewerEngine.current.get()?.version === 1 && window.viewerEngine.model?.ready && !window.viewerEngine.loading.get(), null, { timeout: 120000 });
    await page.waitForTimeout(800);
    const v1 = await panelShape();
    check(v1[0][0] === "Chess set, renamed", "version 1 still shows its own arrangement", v1[0][0]);
    const arrange = page.getByRole("button", { name: /Layers are arranged on the current version/ });
    check(await arrange.isDisabled(), "and cannot be arranged: the button says to open the current version");

    // ---- The upload wizard's Layers step: the suggested names are saved on publish ----
    await page.keyboard.press("Control+k");
    await page.getByRole("option", { name: "Upload model" }).click();
    const dialog = page.getByRole("dialog", { name: "Upload a model" });
    await dialog.locator('input[type="file"]').first().setInputFiles(path.join(ROOT, "apps/web/public/samples/khronos/Lantern.glb"));
    await dialog.getByTestId("upload-report").waitFor({ timeout: 30000 });
    const next = dialog.getByRole("button", { name: "Next" });
    await next.click();
    const inputs = dialog.locator("input.num");
    await inputs.nth(0).fill("34.78");
    await inputs.nth(1).fill("32.08");
    await next.click();
    const offer = dialog.getByLabel("Gather the parts under these standard names when the model is published");
    check(await offer.isChecked(), "the Layers step offers to save the suggested names, on by default");
    await next.click();
    await dialog.getByLabel("Model name *").fill("Lantern arranged on upload");
    await dialog.locator("select.font-semibold").selectOption({ index: 1 });
    await dialog.getByRole("button", { name: "Publish" }).click();
    await dialog.waitFor({ state: "detached", timeout: 180000 });
    await page.waitForFunction(() => {
      const e = window.viewerEngine;
      return e.current.get()?.name === "Lantern arranged on upload" && e.model?.ready && !e.loading.get();
    }, null, { timeout: 120000 });
    const id = await page.evaluate(() => window.viewerEngine.current.get().id);
    let man = null;
    for (let i = 0; i < 40 && !man; i++) {
      await page.waitForTimeout(250);
      man = (await api("GET", `/api/models/${id}/layers`)).manifest;
    }
    const names = [];
    const rec = (ls, d) => ls.forEach((l) => (names.push(`${d}${l.name}`), rec(l.children ?? [], `${d}  `)));
    rec(man?.layers ?? [], "");
    check(JSON.stringify(man?.layers?.map((l) => l.name)) === JSON.stringify(["Lantern"]) && man.layers[0].children?.every((g) => STANDARD.includes(g.name)), "publishing saves the parts under the standard names, inside the file's root", names.join(" | "));
    const panel = await panelShape();
    check(JSON.stringify(panel[0]?.[1]?.map((r) => r[0])) === JSON.stringify(man?.layers?.[0]?.children?.map((g) => g.name)), "and the panel shows them so", JSON.stringify(panel));
  } catch (e) {
    console.error(e);
    failed++;
    await describeFailure(page, "layer-editor");
  }
  check(errors.length === 0, "no page errors", errors.slice(0, 3).join(" | "));
  await browser.close();
  stop();
  console.log(failed ? `${failed} check(s) failed` : "All layer editor checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
