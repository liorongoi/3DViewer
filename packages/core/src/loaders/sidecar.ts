import { epsgDef } from "../geo/crs";
import { placementFrame, transformPoint } from "../geo/place";
import { ecefToGeodetic } from "../geo/wgs84";
import { baseName, type FileSet } from "./files";
import type { CheckItem, CheckReport } from "./types";

/**
 * Position from a sidecar file next to the model (plan 4.1, third in the chain). Bentley
 * ContextCapture / iTwin Capture write `metadata.xml` beside every export:
 *
 *   <ModelMetadata version="1"><SRS>EPSG:2039</SRS><SRSOrigin>219500,631500,800</SRSOrigin></ModelMetadata>
 *
 * The model's vertices are then metres east, north and up of SRSOrigin, in that system. The SRS
 * can also be `ENU:lat,lon` (a local frame at that point) or a compound code (`EPSG:2039+5773`),
 * whose horizontal part is used.
 */
export async function readSidecar(files: FileSet, mainPath: string | null): Promise<{ position: CheckReport["filePosition"]; items: CheckItem[] } | null> {
  const dir = mainPath?.includes("/") ? mainPath.slice(0, mainPath.lastIndexOf("/") + 1) : "";
  const xmls = files.files.filter((f) => baseName(f.path).toLowerCase() === "metadata.xml");
  // Beside the model first, then the shallowest.
  const f = xmls.find((x) => x.path.toLowerCase() === `${dir}metadata.xml`.toLowerCase()) ?? xmls.sort((a, b) => a.path.split("/").length - b.path.split("/").length)[0];
  if (!f) return null;
  return parseMetadataXml(new TextDecoder().decode(await f.bytes()), f.path);
}

const tag = (xml: string, name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`, "i").exec(xml)?.[1];

export function parseMetadataXml(xml: string, path = "metadata.xml"): { position: CheckReport["filePosition"]; items: CheckItem[] } {
  const srs = tag(xml, "SRS");
  const origin = (tag(xml, "SRSOrigin") ?? "0,0,0").split(/[,\s]+/).filter(Boolean).map(Number);
  const [ox = 0, oy = 0, oz = 0] = origin;
  const fail = (detail: string) => ({ position: null, items: [{ id: "georef" as const, severity: "warning" as const, title: `${path} gives no position VIEWER can use`, detail }] });
  if (!srs) return fail("It has no SRS element.");
  if (origin.some((v) => !Number.isFinite(v))) return fail(`Its SRSOrigin "${tag(xml, "SRSOrigin")}" is not three numbers.`);
  const enu = /^ENU:\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)/i.exec(srs);
  if (enu) {
    // A local east-north-up frame at that latitude and longitude; the origin is metres in it.
    const lat = Number(enu[1]);
    const lon = Number(enu[2]);
    const g = ecefToGeodetic((([x, y, z]) => ({ x, y, z }))(transformPoint(placementFrame({ lat, lon }, 0), [ox, oy, oz])));
    return ok({ epsg: 4326, x: g.lon, y: g.lat, height: g.height, source: path }, `${path}: local frame at ${lat.toFixed(5)}°, ${lon.toFixed(5)}°`);
  }
  const code = /^EPSG:\s*(\d+)/i.exec(srs);
  if (!code) return fail(`Its SRS "${srs.slice(0, 80)}" is not an EPSG code or ENU frame. Export with an EPSG code.`);
  const epsg = Number(code[1]);
  if (!epsgDef(epsg)) return fail(`It names EPSG:${epsg}, which is not in VIEWER's list of coordinate systems. Ask the admin to add it, or enter the position by hand.`);
  return ok({ epsg, x: ox, y: oy, height: oz, source: path }, `${path}: EPSG:${epsg}, origin ${ox}, ${oy}, ${oz}`);
}

function ok(position: NonNullable<CheckReport["filePosition"]>, detail: string) {
  return { position, items: [{ id: "georef" as const, severity: "ok" as const, title: "Position from the export's metadata", detail }] };
}
