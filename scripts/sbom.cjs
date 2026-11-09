// Software bill of materials (CycloneDX 1.6 JSON) for one VIEWER release package (WP 6.4, C-2).
//
//   node scripts/sbom.cjs <out.json> --target server|desktop
//
// The npm packages come from `pnpm sbom` (production dependencies only, with versions, licences
// and registry hashes from the lockfile and store): for the server bundle, those of the server,
// the web app and FBX2glTF; for the desktop app, those of the web app and the desktop app. To them
// it adds what the package ships that is not an npm package: Node.js and Caddy in the server
// bundle (NODE_VERSION, CADDY_VERSION, as scripts/build-server-bundle.sh sets them), Electron
// (with its Chromium and Node.js) in the desktop app. VIEWER_VERSION names the release.
//
// It fails when a shipped package has no licence or a licence that scripts/licenses.cjs does not
// allow, so the SBOM and the licence report cannot disagree.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const out = process.argv[2];
const target = process.argv[process.argv.indexOf("--target") + 1];
if (!out || !["server", "desktop"].includes(target)) {
  console.error("Usage: node scripts/sbom.cjs <out.json> --target server|desktop");
  process.exit(2);
}

const filters = target === "server" ? ["@viewer/server...", "@viewer/web...", "@viewer/desktop"] : ["@viewer/web...", "@viewer/desktop..."];
const args = ["sbom", "--sbom-format", "cyclonedx", "--sbom-spec-version", "1.6", "--prod", "--sbom-type", "application", "--sbom-supplier", "VIEWER"];
for (const f of filters) args.push("--filter", f);
const bom = JSON.parse(execFileSync("pnpm", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, shell: process.platform === "win32" }));

const version = process.env.VIEWER_VERSION || (() => {
  try {
    return execFileSync("git", ["describe", "--tags", "--always", "--dirty"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "dev";
  }
})();
const name = target === "server" ? "viewer-server" : "viewer-desktop";
const root = { type: "application", name, version, "bom-ref": `viewer:${name}@${version}`, description: target === "server" ? "VIEWER library server, offline Linux bundle" : "VIEWER desktop app for Windows" };
const oldRoot = bom.metadata.component?.["bom-ref"];
bom.metadata.component = root;
bom.metadata.properties = [{ name: "viewer:target", value: target }, { name: "viewer:commit", value: gitHead() }];

// What the package ships that pnpm does not see.
const extra = [];
const add = (c) => extra.push({ ...c, "bom-ref": c.purl });
if (target === "server") {
  const node = process.env.NODE_VERSION?.replace(/^v/, "");
  const caddy = process.env.CADDY_VERSION;
  if (node) add({ type: "platform", name: "node", version: node, description: "Node.js runtime (official linux-x64 build)", purl: `pkg:generic/nodejs/node@${node}`, licenses: [{ license: { id: "MIT" } }], externalReferences: [{ type: "distribution", url: `https://nodejs.org/dist/v${node}/` }] });
  if (caddy) add({ type: "application", name: "caddy", version: caddy, description: "Caddy web server (official linux-amd64 build)", purl: `pkg:golang/github.com/caddyserver/caddy/v2@v${caddy}`, licenses: [{ license: { id: "Apache-2.0" } }], externalReferences: [{ type: "distribution", url: `https://github.com/caddyserver/caddy/releases/tag/v${caddy}` }] });
} else {
  const electron = require(require.resolve("electron/package.json", { paths: [path.join(ROOT, "apps/desktop")] })).version;
  add({ type: "framework", name: "electron", version: electron, description: "Electron runtime, with the Chromium and Node.js it is built with", purl: `pkg:npm/electron@${electron}`, licenses: [{ license: { id: "MIT" } }], externalReferences: [{ type: "distribution", url: `https://github.com/electron/electron/releases/tag/v${electron}` }] });
}
bom.components.push(...extra);
// The workspace's own packages are VIEWER: the root depends on everything shipped.
for (const d of bom.dependencies) if (d.ref === oldRoot) d.ref = root["bom-ref"];
if (!bom.dependencies.some((d) => d.ref === root["bom-ref"])) bom.dependencies.push({ ref: root["bom-ref"], dependsOn: [] });
const top = bom.dependencies.find((d) => d.ref === root["bom-ref"]);
top.dependsOn = [...new Set([...top.dependsOn, ...extra.map((c) => c["bom-ref"])])];
for (const c of extra) bom.dependencies.push({ ref: c["bom-ref"], dependsOn: [] });

// Every component carries a licence the licence report allows.
const { allowed, EXCEPTIONS } = require("./licenses.cjs");
const own = new Set(["shared", "ui", "core", "api-client", "server", "web", "desktop"]);
const bad = [];
for (const c of bom.components) {
  if (c.group === "@viewer" || (!c.group && own.has(c.name))) continue;
  const ids = (c.licenses ?? []).map((l) => l.license?.id ?? l.license?.name ?? l.expression).filter(Boolean);
  if (!ids.length) bad.push(`${c.name} ${c.version}: no licence`);
  else if (!ids.some((id) => allowed(id)) && !EXCEPTIONS[c.group ? `${c.group}/${c.name}` : c.name]) bad.push(`${c.name} ${c.version}: ${ids.join(", ")}`);
}
if (bad.length) {
  console.error(`The SBOM has packages without an allowed licence:\n  ${bad.join("\n  ")}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, JSON.stringify(bom, null, 2) + "\n");
console.log(`Wrote ${out}: ${target}, ${bom.components.length} components (CycloneDX ${bom.specVersion}).`);

function gitHead() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}
