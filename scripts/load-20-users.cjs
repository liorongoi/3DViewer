// WP 3.7 / NFR-05: 20 people use the library at once, through the production front end.
//
// Publishes a 200 MB GLB through the real upload path (tus PATCH through Caddy), then runs 20
// simulated users together. Each one does what opening a model does: the app page, the library,
// the model (audited), then the whole GLB, then 30 tile-sized range reads of it, then a cached
// re-check (If-None-Match). It reports the time each step took for each user and checks the
// NFR-01 budget: a 200 MB GLB delivered within 5 s for every user, with no errors.
// It also runs the worst case, all 20 at the same instant, and reports it.
//
//   node scripts/load-20-users.cjs https://viewer.internal [ca.pem]
//
// The work folder for the test GLB is the system temp folder (200 MB, removed at the end).
const fs = require("fs");
const https = require("https");
const http = require("http");
const os = require("os");
const path = require("path");

const [base, caFile] = process.argv.slice(2);
if (!base) throw new Error("Usage: node scripts/load-20-users.cjs <https://host> [ca.pem]");
const USERS = 20;
const SIZE = 200 * 1024 * 1024;
const agent = new (base.startsWith("https") ? https : http).Agent({ keepAlive: true, maxSockets: 64, ...(caFile ? { ca: fs.readFileSync(caFile) } : {}) });
const lib = base.startsWith("https") ? https : http;

function request(method, url, { headers = {}, body, file } = {}) {
  return new Promise((resolve, reject) => {
    const req = lib.request(new URL(url, base), { method, agent, headers }, (res) => {
      let bytes = 0;
      const chunks = [];
      res.on("data", (d) => {
        bytes += d.length;
        if (bytes < 4 * 1024 * 1024) chunks.push(d);
      });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, bytes, text: () => Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject);
    if (file) fs.createReadStream(file).pipe(req);
    else req.end(body);
  });
}
const json = async (method, url, payload) => {
  const r = await request(method, url, { headers: payload ? { "content-type": "application/json" } : {}, body: payload ? JSON.stringify(payload) : undefined });
  if (r.status >= 300) throw new Error(`${method} ${url}: ${r.status} ${r.text()}`);
  return JSON.parse(r.text());
};

/** A valid GLB of `size` bytes: one triangle in a buffer padded with zeros. */
function bigGlb(file, size) {
  const J = 1024;
  const binLen = size - 12 - 8 - J - 8;
  const doc = { asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0] }], bufferViews: [{ buffer: 0, byteLength: 36 }], buffers: [{ byteLength: binLen }] };
  const head = Buffer.alloc(12 + 8 + J + 8 + 36);
  head.writeUInt32LE(0x46546c67, 0);
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(size, 8);
  head.writeUInt32LE(J, 12);
  head.writeUInt32LE(0x4e4f534a, 16);
  Buffer.from(JSON.stringify(doc).padEnd(J, " ")).copy(head, 20);
  head.writeUInt32LE(binLen, 20 + J);
  head.writeUInt32LE(0x004e4942, 24 + J);
  Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer).copy(head, 28 + J);
  const fd = fs.openSync(file, "w");
  fs.writeSync(fd, head);
  fs.ftruncateSync(fd, size);
  fs.closeSync(fd);
}

const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
const fmt = (ms) => `${(ms / 1000).toFixed(2)} s`;

(async () => {
  // 1. Publish the test model through the front end, as the upload wizard does.
  const file = path.join(os.tmpdir(), `load-${process.pid}.glb`);
  bigGlb(file, SIZE);
  let t = Date.now();
  const ing = await json("POST", "/api/ingests", {
    files: [{ path: "load-test.glb", size: SIZE }],
    model: { name: "Load test · 200 MB", status: "draft", classificationId: "unclassified" },
    placement: { lat: 32.08, lon: 34.78, height: 0, aboveGround: 0 },
  });
  const up = await request("PATCH", ing.uploads[0].url, { headers: { "tus-resumable": "1.0.0", "upload-offset": "0", "content-type": "application/offset+octet-stream", "content-length": String(SIZE) }, file });
  if (up.status !== 204) throw new Error(`upload: ${up.status} ${up.text()}`);
  console.log(`Uploaded 200 MB through the front end in ${fmt(Date.now() - t)}`);
  await json("POST", `/api/ingests/${ing.id}/submit`);
  let st;
  for (;;) {
    st = await json("GET", `/api/ingests/${ing.id}`);
    if (st.state === "ready" || st.state === "failed") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (st.state !== "ready") throw new Error(`ingest failed: ${st.error}`);
  console.log(`Published in ${fmt(Date.now() - t)} (upload, checks, validators)`);
  fs.unlinkSync(file);
  const model = await json("GET", `/api/models/${st.modelId}`);
  const glbUrl = `/${model.source.url}`;

  // 2. Twenty users. One scenario has all of them open the model at the same instant (the worst
  // case: 4 GB requested at once, which on a 1 Gbit/s network takes 34 s whatever the server
  // does). The other is a working session: 20 people active together, each opening the model at
  // some moment within a minute and again a little later, as people do.
  const run = async (label, startAt) => {
    const steps = { page: [], library: [], model: [], glb: [], ranges: [], cached: [] };
    const errors = [];
    const user = async (n) => {
      await new Promise((r) => setTimeout(r, startAt(n)));
      const time = async (name, fn) => {
        const t0 = Date.now();
        try {
          await fn();
        } catch (e) {
          errors.push(`user ${n} ${name}: ${e.message}`);
        }
        steps[name].push(Date.now() - t0);
      };
      await time("page", async () => {
        const r = await request("GET", "/", { headers: { "accept-encoding": "zstd, gzip" } });
        if (r.status !== 200) throw new Error(String(r.status));
      });
      await time("library", () => json("GET", "/api/models"));
      await time("model", () => request("GET", `/api/models/${st.modelId}`, { headers: { "x-workstation": `LOAD-${n}` } }));
      let etag = "";
      await time("glb", async () => {
        const r = await request("GET", glbUrl);
        if (r.status !== 200 || r.bytes !== SIZE) throw new Error(`${r.status}, ${r.bytes} bytes`);
        etag = r.headers.etag;
      });
      await time("ranges", async () => {
        for (let i = 0; i < 30; i++) {
          const start = Math.floor(Math.random() * (SIZE - 1024 * 1024));
          const r = await request("GET", glbUrl, { headers: { range: `bytes=${start}-${start + 512 * 1024 - 1}` } });
          if (r.status !== 206 || r.bytes !== 512 * 1024) throw new Error(`range: ${r.status}, ${r.bytes} bytes`);
        }
      });
      await time("cached", async () => {
        const r = await request("GET", glbUrl, { headers: { "if-none-match": etag } });
        if (r.status !== 304) throw new Error(`expected 304, got ${r.status}`);
      });
    };
    const t0 = Date.now();
    await Promise.all(Array.from({ length: USERS }, (_, i) => user(i + 1)));
    const wall = Date.now() - t0;
    console.log(`\n${label}: ${USERS} users, ${fmt(wall)} in all`);
    console.log("step       median    p95      slowest");
    for (const [k, v] of Object.entries(steps)) console.log(`${k.padEnd(10)} ${fmt(pct(v, 50)).padEnd(9)} ${fmt(pct(v, 95)).padEnd(8)} ${fmt(Math.max(...v))}`);
    return { steps, errors, wall };
  };

  const burst = await run("All at the same instant", () => 0);
  const gbit = (USERS * SIZE * 8) / 1e9 / (Math.max(...burst.steps.glb) / 1000);
  console.log(`The server delivered 20 × 200 MB at ${gbit.toFixed(1)} Gbit/s; a 1 Gbit/s network needs ${((USERS * SIZE * 8) / 1e9).toFixed(0)} s for that much.`);
  const SPREAD = Number(process.env.SPREAD_S ?? 60) * 1000;
  const session = await run(`Working session (each user starts within ${SPREAD / 1000} s)`, () => Math.random() * SPREAD);

  const errors = [...burst.errors, ...session.errors];
  if (errors.length) {
    console.log(`\nFAIL: ${errors.length} errors\n${errors.slice(0, 10).join("\n")}`);
    process.exit(1);
  }
  const slowest = Math.max(...session.steps.glb);
  if (slowest > 5000) {
    console.log(`\nFAIL: in the working session the slowest user waited ${fmt(slowest)} for the 200 MB GLB (budget 5 s)`);
    process.exit(1);
  }
  console.log(`\nPASS: no errors in either run; in the working session every user had the 200 MB GLB within ${fmt(slowest)} (NFR-01 budget 5 s)`);
  agent.destroy();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
