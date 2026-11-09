// WP 1.9 and 3.9 (VWR-GEO-03, RND-11): the viewer with real map servers, as a site has them.
//
// Against MapServer and MapProxy run here (scripts/lib/map-servers.cjs), in the real web app:
//   - WMTS from MapProxy's capabilities, in its Web Mercator and its WGS 84 grids, and WMS from
//     MapProxy and from MapServer (which reprojects from the Israeli grid on each request);
//   - each layer's tiles arrive, none fails, and the four coloured squares are drawn where they
//     are on the ground: each square's centre on screen shows that square's colour;
//   - the Map tab's own form connects to the WMTS and adds the layer;
//   - an administrator sets MapProxy's WMTS as a site base map, and the viewer shows it.
// With ONLINE=1 (CI, which has the internet), also three public WMTS and a public WMS, read from
// their capabilities: each layer loads its tiles with no error.
//
// Usage: build apps/web and apps/server, start `vite preview` on :4173, then
//   node scripts/check-map-servers.cjs
// Needs mapserv (apt: cgi-mapserver) and mapproxy-util (pip: MapProxy). CHROMIUM may point at a
// Chromium binary; MAPSERV and MAPPROXY at the two programs.
const path = require("node:path");
const { chromium } = require("playwright");
const { startServer } = require("./lib/test-server.cjs");
const { startMapServers } = require("./lib/map-servers.cjs");

const ROOT = path.resolve(__dirname, "..");
const proj4 = require(require.resolve("proj4", { paths: [path.join(ROOT, "packages/core")] }));
const ITM = "+proj=tmerc +lat_0=31.7343936111111 +lon_0=35.2045169444444 +k=1.0000067 +x_0=219529.584 +y_0=626907.39 +ellps=GRS80 +towgs84=23.772,17.49,17.859,-0.3132,-1.85274,1.67299,-5.4262 +units=m +no_defs";

// Public services from different server software: MapProxy (EOX), ArcGIS Server (Esri),
// GeoServer with GeoWebCache (the OpenLayers example server), and a WMS from MapServer (terrestris).
const PUBLIC = [
  { name: "EOX Sentinel-2 cloudless (WMTS, MapProxy)", kind: "wmts", url: "https://tiles.maps.eox.at/wmts/1.0.0/WMTSCapabilities.xml", layer: /^s2cloudless/, at: [34.78, 32.08, 40000] },
  { name: "Esri World Imagery (WMTS, ArcGIS Server)", kind: "wmts", url: "https://services.arcgisonline.com/arcgis/rest/services/World_Imagery/MapServer/WMTS/1.0.0/WMTSCapabilities.xml", layer: /World_Imagery/, at: [34.78, 32.08, 40000] },
  { name: "GeoServer GeoWebCache (WMTS)", kind: "wmts", url: "https://ahocevar.com/geoserver/gwc/service/wmts?REQUEST=GetCapabilities", layer: /states|ne_|countries/i, at: [-98, 39, 4000000] },
  { name: "terrestris OSM (WMS, MapServer)", kind: "wms", url: "https://ows.terrestris.de/osm/service?SERVICE=WMS&REQUEST=GetCapabilities", layer: /^OSM-WMS$/, at: [34.78, 32.08, 40000] },
];

(async () => {
  let failed = 0;
  const check = (ok, what, detail) => {
    console.log(`${ok ? "PASS" : "FAIL"} ${what}${detail !== undefined ? ` (${detail})` : ""}`);
    if (!ok) failed++;
  };
  const maps = await startMapServers();
  const { api, stop } = await startServer();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  // Where each square's centre is, in degrees.
  const squares = maps.quadrants.map(([name, colour, e, n]) => {
    const [lon, lat] = proj4(ITM, "WGS84", [e, n]);
    return { name, colour, lon, lat };
  });
  try {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, reducedMotion: "reduce" });
    ctx.setDefaultTimeout(120000);
    await ctx.addInitScript(() => {
      localStorage.setItem("viewer.lang", "en");
      localStorage.setItem("viewer.quality", "low");
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    // Tile responses, by host.
    const tiles = new Map();
    page.on("response", (r) => {
      const u = new URL(r.url());
      if (u.host === "localhost:4173" || u.host === "127.0.0.1:4173") return;
      const type = r.headers()["content-type"] ?? "";
      const t = tiles.get(u.host) ?? { ok: 0, bad: 0, bytes: 0, last: "" };
      if (r.status() === 200 && type.startsWith("image/")) t.ok++;
      else if (!/xml|text/.test(type) || r.status() >= 400) (t.bad++, (t.last = `${r.status()} ${type} ${r.url().slice(0, 160)}`));
      tiles.set(u.host, t);
    });
    await page.goto("http://localhost:4173/", { waitUntil: "load" });
    await page.waitForFunction(() => !!window.viewerEngine?.widget, null, { timeout: 60000 });
    await page.waitForTimeout(1500);

    /** Looks straight down at [lon, lat] from `height` metres and waits for the globe to load. */
    const lookAt = (lon, lat, height) =>
      page.evaluate(
        async ({ lon, lat, height }) => {
          const e = window.viewerEngine;
          const C3 = e.widget.camera.position.constructor;
          e.widget.camera.setView({ destination: C3.fromDegrees(lon, lat, height), orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 } });
          const t0 = performance.now();
          // Software rendering: the globe can take a while to settle.
          for (let quiet = 0; quiet < 4 && performance.now() - t0 < 90000; ) {
            e.widget.render();
            await new Promise((r) => setTimeout(r, 400));
            quiet = e.widget.scene.globe.tilesLoaded ? quiet + 1 : 0;
          }
        },
        { lon, lat, height },
      );

    /** The colour on screen at each square's centre, as the nearest of the four. */
    const colours = () =>
      page.evaluate(async (squares) => {
        const e = window.viewerEngine;
        const scene = e.widget.scene;
        const C3 = e.widget.camera.position.constructor;
        const Carto = e.widget.camera.positionCartographic.constructor;
        const ground = await e.sampleGround(squares.map((s) => Carto.fromDegrees(s.lon, s.lat)));
        e.widget.render();
        const gl = scene.context._gl;
        const W = gl.drawingBufferWidth;
        const H = gl.drawingBufferHeight;
        const px = new Uint8Array(W * H * 4);
        gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
        const norm = (c) => {
          const s = Math.hypot(...c) || 1;
          return c.map((v) => v / s);
        };
        return squares.map((s, i) => {
          const p = scene.cartesianToCanvasCoordinates(C3.fromDegrees(s.lon, s.lat, ground[i]?.height ?? 0));
          if (!p) return { name: s.name, seen: "off screen" };
          const x = Math.round(p.x * (W / scene.canvas.clientWidth));
          const y = H - 1 - Math.round(p.y * (H / scene.canvas.clientHeight));
          const k = (y * W + x) * 4;
          const c = norm([px[k], px[k + 1], px[k + 2]]);
          const best = squares.map((q) => ({ name: q.name, d: Math.hypot(...norm(q.colour).map((v, j) => v - c[j])) })).sort((a, b) => a.d - b.d)[0];
          return { name: s.name, seen: best.name, rgb: [px[k], px[k + 1], px[k + 2]] };
        });
      }, squares);

    const centre = squares.reduce((a, s) => [a[0] + s.lon / 4, a[1] + s.lat / 4], [0, 0]);
    const placed = async (label) => {
      await lookAt(centre[0], centre[1], 14000);
      const seen = await colours();
      const wrong = seen.filter((s) => s.seen !== s.name);
      check(wrong.length === 0, `${label}: each square is drawn where it is on the ground`, wrong.length ? JSON.stringify(wrong) : "4 of 4");
    };
    const host = (u) => new URL(u).host;
    const tileCount = (u) => tiles.get(host(u)) ?? { ok: 0, bad: 0 };

    /** Adds a layer from a service's capabilities, as the Map tab does. */
    const add = (kind, url, layer) =>
      page.evaluate(
        async ({ kind, url, layer }) => {
          const ul = window.viewerEngine.userLayers;
          const re = new RegExp(layer.source, layer.flags);
          if (kind === "wmts") {
            const all = await ul.listWmts(url);
            const l = all.find((x) => re.test(x.id) && x.crs !== "other");
            if (!l) return { error: `no layer matching ${re} in ${all.map((x) => `${x.id} (${x.matrixSet}, ${x.crs})`).slice(0, 12).join(", ")}` };
            return { id: ul.addWmts(l).id, title: l.title, set: `${l.matrixSet}, ${l.crs}` };
          }
          const caps = await ul.listWms(url);
          const l = caps.layers.find((x) => re.test(x.name));
          if (!l) return { error: `no layer matching ${re} in ${caps.layers.map((x) => x.name).slice(0, 12).join(", ")}` };
          return { id: ul.addWms(caps.url, l.name, l.title, l.bounds).id, title: l.title, set: "WMS" };
        },
        { kind, url, layer: { source: layer.source, flags: layer.flags } },
      );
    const remove = (id) => page.evaluate((id) => window.viewerEngine.userLayers.remove(id), id);

    // ---- The site's own servers ----
    const local = [
      { name: "MapProxy WMTS, Web Mercator grid", kind: "wmts", url: `${maps.mapproxy}wmts/1.0.0/WMTSCapabilities.xml`, layer: /^quadrants$/ },
      { name: "MapProxy WMTS, WGS 84 grid", kind: "wmts", url: `${maps.mapproxy}wmts/1.0.0/WMTSCapabilities.xml`, layer: /^quadrants_geo$/ },
      { name: "MapProxy WMS", kind: "wms", url: `${maps.mapproxy}service?SERVICE=WMS&REQUEST=GetCapabilities`, layer: /^quadrants$/ },
      { name: "MapServer WMS, reprojected from the Israeli grid", kind: "wms", url: `${maps.mapserver}?SERVICE=WMS&REQUEST=GetCapabilities`, layer: /^quadrants$/ },
    ];
    for (const s of local) {
      const before = { ...tileCount(s.url) };
      const r = await add(s.kind, s.url, s.layer);
      if (r.error) {
        check(false, `${s.name}: the layer is offered`, r.error);
        continue;
      }
      check(true, `${s.name}: "${r.title}" added from the capabilities (${r.set})`);
      await placed(s.name);
      const after = tileCount(s.url);
      check(after.ok > before.ok && after.bad === before.bad, `${s.name}: its tiles arrive and none fails`, `${after.ok - before.ok} images${after.bad > before.bad ? `, ${after.bad - before.bad} failed: ${after.last}` : ""}`);
      await remove(r.id);
    }

    // ---- The Map tab's form ----
    // The panel is in the viewer: open a model as a user would, from its card, then its Map tab.
    await page.getByRole("button", { name: /A Beautiful Game/ }).first().click();
    await page.waitForFunction(() => window.viewerEngine.model?.ready, null, { timeout: 120000 });
    await page.getByRole("tab", { name: "Map & data", exact: true }).click();
    await page.getByRole("button", { name: "Add map service", exact: true }).click();
    const input = page.getByRole("textbox", { name: /capabilities|WMTS/i }).first();
    await input.fill(`${maps.mapproxy}wmts/1.0.0/WMTSCapabilities.xml`);
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    const row = page.locator("li", { hasText: "Quadrants through MapProxy" }).first();
    await row.waitFor({ timeout: 30000 });
    await row.getByRole("button", { name: "Add", exact: true }).click();
    const listed = await page.waitForFunction(() => window.viewerEngine.userLayers.list.get().some((l) => l.source === "wmts"), null, { timeout: 15000 }).then(() => true, () => false);
    check(listed, "the Map tab's form connects to the WMTS and adds its layer");
    if (listed) {
      // The model stays where it is; the camera goes to the squares, which the model may cover.
      const before = { ...tileCount(maps.mapproxy) };
      await lookAt(centre[0], centre[1], 14000);
      const after = tileCount(maps.mapproxy);
      check(after.ok > before.ok && after.bad === before.bad, "the layer from the Map tab loads its tiles", `${after.ok - before.ok} images`);
      for (const l of await page.evaluate(() => window.viewerEngine.userLayers.list.get().map((x) => x.id))) await remove(l);
    }

    // ---- A site base map ----
    const cfg = await api("GET", "/api/basemaps");
    const source = { id: "site-mapproxy", label: "MapProxy (site)", kind: "imagery", type: "wmts", url: `${maps.mapproxy}wmts/1.0.0/WMTSCapabilities.xml`, layer: "quadrants" };
    // The administrator makes it the site's default: each viewer then opens on it.
    await api("PUT", "/api/admin/basemaps", { ...cfg, defaultImagery: source.id, sources: [...(cfg.sources ?? []).filter((x) => x.id !== source.id), source] });
    // A fresh start, with no model open over the squares.
    await page.goto("http://localhost:4173/", { waitUntil: "load" });
    await page.waitForFunction(() => !!window.viewerEngine?.widget, null, { timeout: 60000 });
    // The site's sources arrive from the server after the page starts.
    const set = await page
      .waitForFunction(() => window.viewerEngine.baseMapId.get() === "site-mapproxy", null, { timeout: 60000 })
      .then(() => "ok", async () => `the base map is ${await page.evaluate(() => window.viewerEngine.baseMapId.get())}`);
    check(set === "ok", "an administrator's WMTS base map is the one each viewer opens on", set);
    await placed("as the site base map");

    // ---- Public services (CI has the internet) ----
    if (process.env.ONLINE === "1") {
      for (const s of PUBLIC) {
        const before = { ...tileCount(s.url) };
        const r = await add(s.kind, s.url, s.layer).catch((e) => ({ error: String(e) }));
        if (r.error) {
          check(false, `${s.name}: the layer is offered`, r.error);
          continue;
        }
        await lookAt(...s.at);
        const after = tileCount(s.url);
        check(after.ok > before.ok && after.bad === before.bad, `${s.name}: "${r.title}" (${r.set}) loads its tiles with no error`, `${after.ok - before.ok} images${after.bad > before.bad ? `, ${after.bad - before.bad} failed: ${after.last}` : ""}`);
        await remove(r.id);
      }
    } else console.log("  (public services skipped: ONLINE=1 runs them where there is internet)");
    check(errors.length === 0, "no page errors", errors.join("\n"));
  } catch (e) {
    check(false, "the check runs to the end", e.stack ?? e);
  } finally {
    await browser.close();
    stop();
    maps.stop();
  }
  console.log(failed ? `\n${failed} check(s) failed.` : "\nAll map server checks passed.");
  process.exit(failed ? 1 : 0);
})();
