// What a browser check prints when it fails, so a failure on CI names its cause: the page's
// console errors as they happen (the viewer logs why it closed a model), and on failure the
// viewer's state and a screenshot in check-out/ (CI keeps that folder).
const fs = require("node:fs");
const path = require("node:path");

const OUT = path.resolve(__dirname, "../../check-out");

/** Prints the page's console errors and warnings as they happen, with a label. */
function watchConsole(page, label) {
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") console.log(`INFO ${label} console ${m.type()}: ${m.text().slice(0, 600)}`);
  });
  page.on("crash", () => console.log(`INFO ${label}: the page crashed`));
}

/** The viewer's state and a screenshot, within a few seconds even if the page has stopped answering. */
async function describeFailure(page, name) {
  const within = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r("(no answer)"), ms))]);
  const state = await within(
    page
      .evaluate(() => {
        const e = window.viewerEngine;
        return { open: e?.current.get()?.id ?? null, version: e?.current.get()?.version ?? null, loading: e?.loading.get(), error: e?.error.get(), layers: e?.layers.get().length, url: location.href };
      })
      .catch((err) => `(${err.message})`),
    5000,
  );
  console.log(`INFO ${name}: viewer state ${JSON.stringify(state)}`);
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, `${name}.png`);
    await within(page.screenshot({ path: file, timeout: 10000 }), 12000);
    console.log(`INFO ${name}: screenshot ${file}`);
  } catch (err) {
    console.log(`INFO ${name}: no screenshot (${err.message})`);
  }
}

module.exports = { watchConsole, describeFailure };
