// Real map servers for the browser checks, as a site's internal network has them (WP 1.9, 3.9):
//   - MapServer 8 (WMS), run as CGI behind a small HTTP front on :8091, drawing a raster in the
//     Israeli grid (EPSG:2039) that it reprojects for each request;
//   - MapProxy (WMTS, REST and KVP, in Web Mercator and in WGS 84, plus WMS and TMS) on :8090, in
//     front of that MapServer, as sites often run it.
// The raster is four 4 km squares around Tel Aviv, each its own colour, so a check can tell from
// the screen whether the tiles landed in the right place.
//
// Needs `mapserv` (apt: cgi-mapserver) and `mapproxy-util` (pip: MapProxy). MAPPROXY may point at
// mapproxy-util; MAPSERV at mapserv.
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const MAPSERVER = "http://127.0.0.1:8091/";
const MAPPROXY = "http://127.0.0.1:8090/";

/** The four squares: [name, colour, centre easting, centre northing] in EPSG:2039. */
const QUADRANTS = [
  ["north-west", [230, 30, 30], 178000, 667000],
  ["north-east", [30, 200, 30], 182000, 667000],
  ["south-west", [30, 60, 230], 178000, 663000],
  ["south-east", [240, 220, 30], 182000, 663000],
];

function files(dir) {
  fs.writeFileSync(path.join(dir, "quadrants.asc"), "ncols 4\nnrows 4\nxllcorner 176000\nyllcorner 661000\ncellsize 2000\nNODATA_value 0\n1 1 2 2\n1 1 2 2\n3 3 4 4\n3 3 4 4\n");
  const classes = QUADRANTS.map(([, c], i) => `    CLASS\n      EXPRESSION ([pixel] = ${i + 1})\n      STYLE COLOR ${c.join(" ")} END\n    END`).join("\n");
  fs.writeFileSync(
    path.join(dir, "test.map"),
    `MAP
  NAME "viewer-test"
  EXTENT 170000 655000 190000 675000
  SIZE 512 512
  UNITS METERS
  IMAGETYPE png
  PROJECTION "init=epsg:2039" END
  WEB
    METADATA
      "wms_title" "VIEWER test MapServer"
      "wms_onlineresource" "${MAPSERVER}?"
      "wms_srs" "EPSG:2039 EPSG:3857 EPSG:4326"
      "wms_enable_request" "*"
    END
  END
  LAYER
    NAME "quadrants"
    TYPE RASTER
    STATUS ON
    DATA "${path.join(dir, "quadrants.asc")}"
    PROJECTION "init=epsg:2039" END
    PROCESSING "RESAMPLE=NEAREST"
    METADATA
      "wms_title" "Quadrants in the Israeli grid"
      "wms_srs" "EPSG:2039 EPSG:3857 EPSG:4326"
    END
${classes}
  END
END
`,
  );
  fs.writeFileSync(path.join(dir, "mapserver.conf"), `CONFIG\n  ENV\n    MS_MAPFILE "${path.join(dir, "test.map")}"\n  END\nEND\n`);
  fs.writeFileSync(
    path.join(dir, "mapproxy.yaml"),
    `services:
  demo:
  tms:
  wms:
    srs: ["EPSG:3857", "EPSG:4326"]
    md: { title: VIEWER test MapProxy }
  wmts:
    restful: true
    kvp: true
    md: { title: VIEWER test MapProxy }
layers:
  - name: quadrants
    title: Quadrants through MapProxy
    sources: [quadrants_cache]
  - name: quadrants_geo
    title: Quadrants through MapProxy, WGS 84 grid
    sources: [quadrants_geo_cache]
caches:
  quadrants_cache:
    grids: [webmercator]
    sources: [quadrants_wms]
    disable_storage: true
    format: image/png
  quadrants_geo_cache:
    grids: [wgs84]
    sources: [quadrants_wms]
    disable_storage: true
    format: image/png
sources:
  quadrants_wms:
    type: wms
    req: { url: "${MAPSERVER}", layers: quadrants, transparent: true }
    supported_srs: ["EPSG:3857", "EPSG:4326"]
grids:
  webmercator: { base: GLOBAL_WEBMERCATOR }
  # Two tiles across the world at level 0, as GeoServer's EPSG:4326 grid set and Cesium have it.
  wgs84: { srs: "EPSG:4326", bbox: [-180, -90, 180, 90], origin: nw, min_res: 0.703125, num_levels: 18 }
globals:
  cache: { base_dir: "${path.join(dir, "cache")}" }
`,
  );
}

/** MapServer is a CGI program: one process a request, behind this HTTP front. */
function mapserverFront(dir, bin) {
  return http.createServer((req, res) => {
    const q = req.url.includes("?") ? req.url.slice(req.url.indexOf("?") + 1) : "";
    const p = spawn(bin, [], {
      env: { PATH: process.env.PATH, MAPSERVER_CONFIG_FILE: path.join(dir, "mapserver.conf"), REQUEST_METHOD: "GET", QUERY_STRING: q, SERVER_NAME: "127.0.0.1", SERVER_PORT: "8091", SCRIPT_NAME: "/", GATEWAY_INTERFACE: "CGI/1.1" },
    });
    const out = [];
    p.stdout.on("data", (d) => out.push(d));
    p.on("close", () => {
      const all = Buffer.concat(out);
      let i = all.indexOf("\r\n\r\n");
      let skip = 4;
      if (i < 0) (i = all.indexOf("\n\n")), (skip = 2);
      if (i < 0) return res.writeHead(502).end("mapserv wrote no headers");
      const headers = {};
      for (const line of all.subarray(0, i).toString().split(/\r?\n/)) {
        const m = line.match(/^([^:]+):\s*(.*)$/);
        if (m) headers[m[1]] = m[2];
      }
      const status = Number((headers.Status ?? "200").split(" ")[0]) || 200;
      delete headers.Status;
      res.writeHead(status, { ...headers, "access-control-allow-origin": "*" });
      res.end(all.subarray(i + skip));
    });
  });
}

/** Starts both; resolves when each answers its capabilities. */
async function startMapServers() {
  const mapserv = process.env.MAPSERV || "mapserv";
  const mapproxy = process.env.MAPPROXY || "mapproxy-util";
  for (const [bin, what] of [[mapserv, "mapserv (apt: cgi-mapserver)"], [mapproxy, "mapproxy-util (pip: MapProxy)"]])
    if (spawnSync(bin, ["-v"]).error && spawnSync(bin, ["--version"]).error) throw new Error(`${what} is needed.`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "viewer-mapservers-"));
  files(dir);
  const front = mapserverFront(dir, mapserv);
  await new Promise((r) => front.listen(8091, "127.0.0.1", r));
  const log = [];
  // Its own process group: the development server restarts itself in a child process.
  const mp = spawn(mapproxy, ["serve-develop", path.join(dir, "mapproxy.yaml"), "-b", "127.0.0.1:8090"], { stdio: ["ignore", "pipe", "pipe"], detached: true });
  mp.stdout.on("data", (d) => log.push(String(d)));
  mp.stderr.on("data", (d) => log.push(String(d)));
  const stop = () => {
    try {
      process.kill(-mp.pid, "SIGKILL");
    } catch {
      mp.kill("SIGKILL");
    }
    front.closeAllConnections?.();
    front.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  const ok = (u) => fetch(u).then((r) => r.ok, () => false);
  for (let i = 0; ; i++) {
    if ((await ok(`${MAPSERVER}?SERVICE=WMS&REQUEST=GetCapabilities`)) && (await ok(`${MAPPROXY}wmts/1.0.0/WMTSCapabilities.xml`))) break;
    if (i > 60 || mp.exitCode !== null) {
      stop();
      throw new Error(`The map servers did not start:\n${log.join("").slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return { mapserver: MAPSERVER, mapproxy: MAPPROXY, quadrants: QUADRANTS, stop };
}

module.exports = { startMapServers, QUADRANTS };
