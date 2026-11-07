// Production gap 5: every user-facing string in the web app goes through i18next, so the
// Hebrew interface never shows English. This fails (exit 1) on any string written straight into
// the interface:
//   - text between JSX tags;
//   - a string in a user-facing attribute (label, title, aria-label, placeholder, alt…);
//   - a string inside a {…} that is shown, such as {busy ? "Saving…" : "Save"};
//   - a string given as a label, title, hint, message… property, or to setError(), fail() and
//     the like.
// Allowed: names and codes that stay in Latin letters in Hebrew too (formats, units, key names,
// EPSG…), text inside an element marked translate="no", and a line with a
// trailing or preceding `i18n-ignore` comment.
//
// Usage: node scripts/check-i18n.cjs [files…]   (default: apps/web/src and packages/core/src)
const fs = require("fs");
const path = require("path");
// The TypeScript 7 package has no JavaScript API yet; the 5.x compiler that openapi-typescript
// brings in parses TSX the same way.
const ts = require(require.resolve("typescript", { paths: [path.join(__dirname, "../packages/api-client")] }));

const LATIN_OK = new Set(
  "VIEWER GLB glTF gltf FBX OBJ 3D Tiles tileset json zip KTX2 PNG JPG CSV GeoJSON GeoTIFF COG KML KMZ WMTS WMS XYZ TMS SHP shapefile EPSG WGS ITM UTM N S E W km m cm mm ft in MB GB KB TB px fps Ctrl Shift Alt Esc Enter Tab Space PgUp PgDn Home End F Del Backspace Cesium CesiumJS OpenStreetMap OSM Esri AWS Terrarium Sentinel Lyon Tarn Jerusalem Natural Earth ISO TOP API IP SIEM CEF HTTPS URL ID AA WCAG English x y z X Y Z A B Q WASD".split(" "),
);
const UI_ATTRS = new Set(["label", "title", "aria-label", "aria-description", "aria-valuetext", "placeholder", "alt", "hint", "tip", "data-tip", "tooltip", "backLabel", "description", "message", "heading", "subtitle", "caption", "emptyText", "note", "confirmLabel", "summary"]);
const UI_PROPS = /^(label|title|hint|tip|tooltip|description|message|text|placeholder|caption|note|summary|heading|subtitle|detail|help|unitLabel|ariaLabel)$/;
const UI_CALLS = /^(set\w*(Error|Message|Note|Status|Hint|Problem|Notice|Warning)s?|fail|toast|notify|announce|warn\w*|report)$/;

/** True when the text has a word a Hebrew reader would see as English. */
function english(text) {
  for (const w of text.match(/[A-Za-z][A-Za-z'’]*/g) ?? []) {
    const word = w.replace(/['’]+$/, "");
    if (LATIN_OK.has(word) || /^[A-Z0-9]{2,}$/.test(word) || word.length < 2) continue;
    return true;
  }
  return false;
}
/** Text that reads as a sentence or label, not an identifier ("levels", "image/jpeg", "#fff"). */
function looksShown(text) {
  const s = text.trim();
  if (!english(s)) return false;
  if (/^[a-z][\w.:/-]*$/.test(s)) return false; // an id, key, path or mime type
  return /\s/.test(s) || /^[A-Z][a-z]/.test(s) || /[…:.!?]$/.test(s);
}

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return files(p);
    return /\.(tsx?|jsx?)$/.test(d.name) && !/\.(test|e2e\.test)\.tsx?$/.test(d.name) && !d.name.endsWith(".d.ts") ? [p] : [];
  });
}

const args = process.argv.slice(2);
const list = args.length ? args : [...files(path.join(__dirname, "../apps/web/src")), ...files(path.join(__dirname, "../packages/core/src"))];
const problems = [];
for (const f of list) {
  const src = fs.readFileSync(f, "utf8");
  const lines = src.split("\n");
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, f.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const ignored = (node) => {
    const line = sf.getLineAndCharacterOfPosition(node.getStart()).line;
    if (/i18n-ignore/.test(lines[line]) || /i18n-ignore/.test(lines[line - 1] ?? "")) return true;
    for (let p = node.parent; p; p = p.parent) {
      if (ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p)) {
        const attrs = (ts.isJsxElement(p) ? p.openingElement : p).attributes.properties;
        for (const a of attrs)
          if (ts.isJsxAttribute(a) && a.initializer && ts.isStringLiteral(a.initializer) && a.name.getText() === "translate" && a.initializer.text === "no")
            return true;
      }
    }
    return false;
  };
  const report = (node, text, why) => {
    if (ignored(node)) return;
    const { line } = sf.getLineAndCharacterOfPosition(node.getStart());
    problems.push(`${path.relative(process.cwd(), f)}:${line + 1}: ${why}: ${JSON.stringify(text.trim().replace(/\s+/g, " ").slice(0, 70))}`);
  };
  const literalText = (n) => (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) ? n.text : ts.isTemplateExpression(n) ? [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(" ") : null);

  /** Strings that end up shown: walks an expression, leaving out call arguments, comparisons and keys. */
  const shownStrings = (n, why) => {
    const t = literalText(n);
    if (t !== null) {
      if (looksShown(t)) report(n, t, why);
      if (!ts.isTemplateExpression(n)) return;
    }
    if (ts.isCallExpression(n) || ts.isJsxAttribute(n) || ts.isElementAccessExpression(n)) return;
    if (ts.isPropertyAssignment(n) && !UI_PROPS.test(n.name.getText())) return; // font: "…", id: "…"
    if (ts.isBinaryExpression(n) && /=|in|instanceof/.test(ts.tokenToString(n.operatorToken.kind) ?? "")) return;
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) return; // visited on its own
    ts.forEachChild(n, (c) => shownStrings(c, why));
  };

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      const t = node.getText();
      if (english(t)) report(node, t, "text in JSX");
    } else if (ts.isJsxAttribute(node) && node.initializer && UI_ATTRS.has(node.name.getText())) {
      const i = node.initializer;
      if (ts.isStringLiteral(i)) {
        if (english(i.text)) report(i, i.text, `${node.name.getText()}=`);
      } else if (ts.isJsxExpression(i) && i.expression) shownStrings(i.expression, `${node.name.getText()}=`);
    } else if (ts.isJsxExpression(node) && node.expression && !ts.isJsxAttribute(node.parent)) {
      shownStrings(node.expression, "string in JSX");
    } else if (ts.isPropertyAssignment(node) && UI_PROPS.test(node.name.getText())) {
      shownStrings(node.initializer, `${node.name.getText()}:`);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression.getText().split(".").pop();
      if (UI_CALLS.test(callee)) for (const a of node.arguments) shownStrings(a, `${callee}()`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

for (const p of problems) console.log(p);
if (problems.length) {
  console.log(`\n${problems.length} string(s) written straight into the interface. Put them in packages/shared/src/i18n.ts (English and Hebrew) and use t().`);
  process.exit(1);
}
console.log("No hard-coded interface strings.");
