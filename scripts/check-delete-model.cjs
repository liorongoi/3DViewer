// Deleting models from the library, in the web app:
//
//   - A server model, from its library card: the dialog asks for the admin password and the
//     model's name; the model leaves the library, the server answers 404 for it, and the audit
//     log records the delete.
//   - A server model from the open model's header, while signed in: only the name is asked, and
//     the viewer goes back to the globe.
//   - The bundled samples (no server) have no delete button.
//   - A model opened from this computer: removed from the library after one confirmation.
//
// Usage: build apps/web and apps/server, start `vite preview` on :4173, then
// node scripts/check-delete-model.cjs (CHROMIUM may point at a Chromium binary; SHOTS=<folder>
// saves screenshots). The check starts its own server on :8787 for the first part.
const { chromium } = require("playwright");
const { startServer } = require("./lib/test-server.cjs");

const PASSWORD = "check-server-only-0123";

/** A GLB with one small triangle. */
function tinyGlb() {
  const d = 0.5;
  const pos = new Float32Array([-d, 0, -d, d, 0, -d, 0, d, 0]);
  const bin = Buffer.from(pos.buffer);
  const doc = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name: "Marker", mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [-d, 0, -d], max: [d, d, 0] }],
    bufferViews: [{ buffer: 0, byteLength: bin.length }],
    buffers: [{ byteLength: bin.length }],
  };
  let json = Buffer.from(JSON.stringify(doc));
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)]);
  const chunk = (type, data) => {
    const h = Buffer.alloc(8);
    h.writeUInt32LE(data.length, 0);
    h.writeUInt32LE(type, 4);
    return Buffer.concat([h, data]);
  };
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8);
  return Buffer.concat([head, chunk(0x4e4f534a, json), chunk(0x004e4942, bin)]);
}

(async () => {
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` (${detail})` : ""}`);
    if (!ok) failed++;
  };
  const shots = process.env.SHOTS;
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const newPage = async () => {
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    await ctx.addInitScript(() => {
      localStorage.setItem("viewer.lang", "en");
      localStorage.setItem("viewer.fadeTools", "false");
      localStorage.setItem("viewer.quality", "low");
      localStorage.setItem("viewer.onboarding", "1");
    });
    ctx.setDefaultTimeout(120000);
    const page = await ctx.newPage();
    page.on("pageerror", (e) => check(false, "no page errors", e.message));
    await page.goto("http://localhost:4173/", { waitUntil: "load" });
    await page.waitForFunction(() => !!window.viewerEngine, null, { timeout: 60000 });
    return page;
  };
  const names = (page) => page.locator("[data-model-card] [dir=auto]").allInnerTexts();

  // ---- On the server ----
  const { api, audit, stop } = await startServer({ password: PASSWORD });
  try {
    const page = await newPage();
    await page.locator("[data-model-card]").first().waitFor();
    const models = await api("GET", "/api/models");
    const [first, second] = models;
    const card = page.locator("div.group\\/card", { has: page.getByText(first.name, { exact: true }) }).first();
    await card.hover();
    if (shots) await page.screenshot({ path: `${shots}/delete-hover.png`, clip: { x: 0, y: 0, width: 400, height: 450 } });
    await card.getByTestId("delete-model-open").click();
    const dialog = page.getByTestId("delete-model");
    await dialog.waitFor();
    check((await dialog.innerText()).includes(`Delete ${first.name}?`), "the dialog names the model");
    const go = dialog.getByTestId("delete-model-go");
    check(await go.isDisabled(), "Delete is off until the password and name are given");
    await dialog.getByTestId("delete-model-password").fill(PASSWORD);
    await dialog.getByTestId("delete-model-name").fill(first.name + "x");
    check(await go.isDisabled(), "a wrong name keeps Delete off");
    await dialog.getByTestId("delete-model-name").fill(first.name);
    if (shots) await page.screenshot({ path: `${shots}/delete-server.png` });
    await go.click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction((n) => ![...document.querySelectorAll("[data-model-card] [dir=auto]")].some((e) => e.textContent === n), first.name);
    check(!(await names(page)).includes(first.name), "the model left the library");
    const gone = await fetch(`http://127.0.0.1:8787/api/models/${first.id}`).then((r) => r.status);
    check(gone === 404, "the server no longer has it", gone);
    check((await audit(first.id, "model.delete")).length === 1, "the audit log records the delete");

    // From the open model's header, already signed in.
    await page.getByText(second.name, { exact: true }).first().click();
    await page.waitForFunction((id) => window.viewerEngine.current.get()?.id === id, second.id);
    await page.getByTestId("delete-model-header").click();
    await dialog.waitFor();
    check((await dialog.getByTestId("delete-model-password").count()) === 0, "signed in: no password asked again");
    await dialog.getByTestId("delete-model-name").fill(second.name);
    await dialog.getByTestId("delete-model-go").click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => !window.viewerEngine.current.get());
    check(true, "the viewer closed the deleted model");
    check((await fetch(`http://127.0.0.1:8787/api/models/${second.id}`).then((r) => r.status)) === 404, "the server no longer has the second model");
    await page.context().close();
  } finally {
    stop();
  }

  // ---- Without a server: samples stay, this computer's models can be removed ----
  {
    const page = await newPage();
    await page.locator("[data-model-card]").first().waitFor();
    check((await page.getByTestId("delete-model-open").count()) === 0, "the bundled samples have no delete button");
    await page.getByRole("button", { name: "Upload model" }).first().click();
    const up = page.getByRole("dialog", { name: "Upload a model" });
    await up.locator('input[type="file"]').first().setInputFiles({ name: "delete-me.glb", mimeType: "model/gltf-binary", buffer: tinyGlb() });
    await up.getByTestId("upload-report").waitFor({ timeout: 30000 });
    const next = up.getByRole("button", { name: "Next" });
    while (await next.isVisible().catch(() => false)) await next.click();
    await up.locator("select.font-semibold").selectOption({ index: 1 }).catch(() => undefined);
    await up.getByRole("button", { name: "Publish" }).click();
    await up.waitFor({ state: "detached" });
    await page.waitForFunction(() => window.viewerEngine.current.get()?.id?.startsWith("upload-"));
    await page.getByTestId("delete-model-header").click();
    const dialog = page.getByTestId("delete-model");
    await dialog.waitFor();
    const text = await dialog.innerText();
    check(text.includes("Remove delete me?") && text.includes("stay on this computer"), "a local model is removed, its files kept", text.split("\n")[0]);
    if (shots) await page.screenshot({ path: `${shots}/delete-local.png` });
    await dialog.getByTestId("delete-model-go").click();
    await dialog.waitFor({ state: "detached" });
    await page.waitForFunction(() => !window.viewerEngine.current.get());
    check(!(await names(page)).includes("delete me"), "the local model left the library");
  }

  await browser.close();
  console.log(failed ? `${failed} check(s) failed` : "All checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
