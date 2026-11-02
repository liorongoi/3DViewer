/**
 * Minimal OGC capabilities readers for WMTS and WMS (plan WP 1.9). Only what the viewer
 * needs to list layers and build a Cesium provider; no third-party XML library.
 */

export interface WmtsLayerInfo {
  id: string;
  title: string;
  format: string;
  style: string;
  matrixSet: string;
  /** "3857" for Google Maps compatible sets, "4326" for geographic ones. */
  crs: "3857" | "4326" | "other";
  matrixLabels: string[];
  /** RESTful template ({TileMatrix}, {TileRow}, {TileCol}, {Style}...) or null for KVP. */
  template: string | null;
  /** KVP base URL when there is no template. */
  kvpUrl: string;
  bounds?: [number, number, number, number];
}

export interface WmsLayerInfo {
  name: string;
  title: string;
  bounds?: [number, number, number, number];
}

const local = (el: Element) => el.localName;
const kids = (el: Element | Document, name: string) => Array.from(el.childNodes).filter((n): n is Element => n.nodeType === 1 && local(n as Element) === name);
const kid = (el: Element | Document, name: string) => kids(el, name)[0];
const text = (el: Element | undefined, name: string) => (el ? kid(el, name)?.textContent?.trim() ?? "" : "");
const all = (el: Element | Document, name: string) => Array.from(el.getElementsByTagNameNS("*", name));

async function fetchXml(url: string): Promise<Document> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`The server answered ${res.status} for ${url}`);
  const doc = new DOMParser().parseFromString(await res.text(), "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error("The capabilities document is not valid XML.");
  return doc;
}

/** Accepts a GetCapabilities URL or a service root, and returns the capabilities URL. */
export function capabilitiesUrl(url: string, service: "WMTS" | "WMS"): string {
  const u = new URL(url, document.baseURI);
  if (/\.xml$/i.test(u.pathname) || /request=getcapabilities/i.test(u.search)) return u.href;
  u.searchParams.set("SERVICE", service);
  u.searchParams.set("REQUEST", "GetCapabilities");
  if (service === "WMS") u.searchParams.set("VERSION", "1.3.0");
  return u.href;
}

export async function readWmts(url: string): Promise<WmtsLayerInfo[]> {
  const capsUrl = capabilitiesUrl(url, "WMTS");
  const doc = await fetchXml(capsUrl);
  const contents = all(doc, "Contents")[0];
  if (!contents) throw new Error("No WMTS Contents in the capabilities document.");

  const sets = new Map<string, { crs: WmtsLayerInfo["crs"]; labels: string[] }>();
  for (const s of kids(contents, "TileMatrixSet")) {
    const id = text(s, "Identifier");
    const crsText = text(s, "SupportedCRS");
    const wkss = text(s, "WellKnownScaleSet");
    const crs = /3857|900913|GoogleMapsCompatible/i.test(crsText + wkss + id) ? "3857" : /4326|CRS84/i.test(crsText) ? "4326" : "other";
    sets.set(id, { crs, labels: kids(s, "TileMatrix").map((m) => text(m, "Identifier")) });
  }

  // KVP endpoint from OperationsMetadata, else the capabilities URL without its query.
  let kvp = capsUrl.split("?")[0]!;
  for (const op of all(doc, "Operation")) {
    if (op.getAttribute("name") !== "GetTile") continue;
    const get = all(op, "Get")[0];
    const href = get?.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? get?.getAttribute("xlink:href");
    if (href) kvp = new URL(href, capsUrl).href;
  }

  return kids(contents, "Layer").map((l) => {
    const id = text(l, "Identifier");
    const formats = kids(l, "Format").map((f) => f.textContent!.trim());
    const styleEl = kids(l, "Style").find((s) => s.getAttribute("isDefault") === "true") ?? kid(l, "Style");
    const links = kids(l, "TileMatrixSetLink").map((k) => text(k, "TileMatrixSet"));
    const matrixSet = links.find((m) => sets.get(m)?.crs === "3857") ?? links.find((m) => sets.get(m)?.crs === "4326") ?? links[0] ?? "";
    const res = kids(l, "ResourceURL").find((r) => r.getAttribute("resourceType") === "tile");
    const set = sets.get(matrixSet);
    const bb = kid(l, "WGS84BoundingBox");
    let bounds: WmtsLayerInfo["bounds"];
    if (bb) {
      const [w, s] = text(bb, "LowerCorner").split(/\s+/).map(Number);
      const [e, n] = text(bb, "UpperCorner").split(/\s+/).map(Number);
      if ([w, s, e, n].every((v) => Number.isFinite(v))) bounds = [w!, s!, e!, n!];
    }
    return {
      id,
      title: text(l, "Title") || id,
      format: res?.getAttribute("format") ?? formats.find((f) => /png|jpe?g/.test(f)) ?? formats[0] ?? "image/png",
      style: styleEl ? text(styleEl, "Identifier") || "default" : "default",
      matrixSet,
      crs: set?.crs ?? "other",
      matrixLabels: set?.labels ?? [],
      template: res ? new URL(res.getAttribute("template")!.replace(/\{/g, "%7B").replace(/\}/g, "%7D"), capsUrl).href.replace(/%7B/gi, "{").replace(/%7D/gi, "}") : null,
      kvpUrl: kvp,
      bounds,
    };
  });
}

export async function readWms(url: string): Promise<{ url: string; layers: WmsLayerInfo[] }> {
  const capsUrl = capabilitiesUrl(url, "WMS");
  const doc = await fetchXml(capsUrl);
  let getMap = capsUrl.split("?")[0]!;
  const gm = all(doc, "GetMap")[0];
  const res = gm ? all(gm, "OnlineResource")[0] : undefined;
  const href = res?.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? res?.getAttribute("xlink:href");
  if (href) getMap = new URL(href, capsUrl).href;
  const layers = all(doc, "Layer")
    .map((l) => {
      const name = text(l, "Name");
      const bb = kid(l, "EX_GeographicBoundingBox");
      const n = (k: string) => Number(text(bb, k));
      return {
        name,
        title: text(l, "Title") || name,
        bounds: bb ? ([n("westBoundLongitude"), n("southBoundLatitude"), n("eastBoundLongitude"), n("northBoundLatitude")] as [number, number, number, number]) : undefined,
      };
    })
    .filter((l) => l.name);
  return { url: getMap, layers };
}
