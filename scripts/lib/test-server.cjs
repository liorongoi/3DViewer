// The real VIEWER server for a browser check: apps/server (built) on :8787, with an empty
// database in a temporary folder and the sample library. The web app's `vite preview` on :4173
// passes /api to it.
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "../..");
const API = "http://127.0.0.1:8787";

/**
 * Starts the server and signs in as administrator (to read the audit log). With workers, it
 * also runs upload jobs (no thumbnails: they would start a second browser). `env` adds server
 * settings.
 */
async function startServer({ password = "check-server-only-0123", workers = false, env = {} } = {}) {
  // A server left over from an earlier run would answer in place of this one.
  if (await fetch(`${API}/api/health/live`).then(() => true, () => false)) throw new Error(`Something already answers on ${API}: stop it first.`);
  const data = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-check-"));
  const log = [];
  const srv = spawn(process.execPath, ["dist/main.js"], {
    cwd: path.join(ROOT, "apps/server"),
    env: { ...without(process.env, "CHROMIUM"), DATA_DIR: data, WORKERS: workers ? "1" : "0", ADMIN_PASSWORD: password, PORT: "8787", HOST: "127.0.0.1", NODE_ENV: "development", SEED_SAMPLES: "1", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  srv.stdout.on("data", (d) => log.push(String(d)));
  srv.stderr.on("data", (d) => log.push(String(d)));
  const stop = () => {
    srv.kill("SIGKILL");
    fs.rmSync(data, { recursive: true, force: true });
  };
  for (let i = 0; ; i++) {
    if (await fetch(`${API}/api/health`).then((r) => r.ok, () => false)) break;
    if (i > 60 || srv.exitCode !== null) {
      stop();
      throw new Error(`The server did not start:\n${log.join("")}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  let token;
  const api = async (method, url, body) => {
    const r = await fetch(`${API}${url}`, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), "x-workstation": "browser-check" },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`${method} ${url}: ${r.status} ${await r.text()}`);
    return r.json();
  };
  token = (await api("POST", "/api/admin/login", { password })).token;
  /** Audit entries for one model and action, newest first. */
  const audit = async (target, action) => (await api("GET", `/api/audit?target=${encodeURIComponent(target)}&action=${encodeURIComponent(action)}`)).filter((e) => e.target === target);
  return { api, audit, stop };
}

function without(env, key) {
  const out = { ...env };
  delete out[key];
  return out;
}

module.exports = { startServer, API };
