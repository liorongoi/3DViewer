import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { convergence, satellitePreflight, tiffHasRpc, viewAngles } from "./satellite.ts";

/** A tiny classic TIFF whose first directory holds the given tags (values unused). */
function tiff(tags: number[], le = true): Buffer {
  const b = Buffer.alloc(8 + 2 + tags.length * 12 + 4);
  b.write(le ? "II" : "MM", 0, "latin1");
  const u16 = (v: number, o: number) => (le ? b.writeUInt16LE(v, o) : b.writeUInt16BE(v, o));
  const u32 = (v: number, o: number) => (le ? b.writeUInt32LE(v, o) : b.writeUInt32BE(v, o));
  u16(42, 2);
  u32(8, 4);
  u16(tags.length, 8);
  tags.forEach((t, k) => u16(t, 10 + k * 12));
  return b;
}
const imd = (az: number, el: number) => `BEGIN_GROUP = IMAGE_1\n\tmeanSatAz = ${az};\n\tmeanSatEl = ${el};\nEND_GROUP = IMAGE_1\n`;

describe("satellite capture check", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "viewer-sat-"));
  });
  afterAll(async () => rm(dir, { recursive: true, force: true }));
  const put = async (files: Record<string, string | Buffer>) => {
    const sub = await mkdtemp(path.join(dir, "c-"));
    for (const [n, d] of Object.entries(files)) await writeFile(path.join(sub, n), d);
    return { sub, names: Object.keys(files) };
  };

  it("finds RPC tags inside TIFFs in either byte order", async () => {
    const { sub } = await put({ "a.tif": tiff([256, 257, 50844]), "b.tif": tiff([256, 257, 50844], false), "c.tif": tiff([256, 257]) });
    expect(await tiffHasRpc(path.join(sub, "a.tif"))).toBe(true);
    expect(await tiffHasRpc(path.join(sub, "b.tif"))).toBe(true);
    expect(await tiffHasRpc(path.join(sub, "c.tif"))).toBe(false);
  });

  it("reads view directions from IMD, XML and DIMAP metadata, and the angle between views", () => {
    expect(viewAngles(imd(120.5, 70))).toEqual({ azimuth: 120.5, elevation: 70 });
    expect(viewAngles("<IMD><MEANSATAZ>10</MEANSATAZ><MEANSATEL>80.5</MEANSATEL></IMD>")).toEqual({ azimuth: 10, elevation: 80.5 });
    expect(viewAngles('<Located_Geometric_Values><AZIMUTH_ANGLE unit="deg">200</AZIMUTH_ANGLE><INCIDENCE_ANGLE unit="deg">15</INCIDENCE_ANGLE></Located_Geometric_Values>')).toEqual({ azimuth: 200, elevation: 75 });
    expect(viewAngles("nothing here")).toBeNull();
    // Straight down and 20 degrees off vertical are 20 degrees apart, whatever the azimuth.
    expect(convergence({ azimuth: 0, elevation: 90 }, { azimuth: 77, elevation: 70 })).toBeCloseTo(20, 9);
  });

  it("accepts calibrated views from different directions", async () => {
    const { sub, names } = await put({ "p1.tif": "x", "p1.RPB": "rpc", "p1.IMD": imd(30, 75), "p2.tif": "x", "p2_RPC.TXT": "rpc", "p2.IMD": imd(210, 72), "p3.tif": tiff([50844]) });
    const r = await satellitePreflight(sub, names);
    expect(r.problem).toBeNull();
    expect(r.views.map((v) => v.rpc)).toEqual(["sidecar", "sidecar", "embedded"]);
    expect(r.convergenceDeg!).toBeGreaterThan(30);
    expect(r.warnings).toEqual([]);
  });

  it("refuses, with what to do, views without a camera model, a single view, views from one direction, and a bare satellite video", async () => {
    const noRpc = await put({ "p1.tif": "x", "p1.RPB": "rpc", "p2.ntf": "x" });
    expect((await satellitePreflight(noRpc.sub, noRpc.names)).problem).toMatch(/This image has no RPC camera model: p2\.ntf\. Add/);
    const one = await put({ "p1.tif": "x", "p1.RPB": "rpc" });
    expect((await satellitePreflight(one.sub, one.names)).problem).toMatch(/At least two/);
    const same = await put({ "p1.tif": "x", "p1.RPB": "r", "p1.IMD": imd(30, 80), "p2.tif": "x", "p2.RPB": "r", "p2.IMD": imd(35, 81) });
    const s = await satellitePreflight(same.sub, same.names);
    expect(s.problem).toMatch(/almost the same direction \(at most 1\.\d°/);
    const video = await put({ "skysat.mp4": "x" });
    expect((await satellitePreflight(video.sub, video.names)).problem).toMatch(/camera model for every frame/);
  });

  it("uses a video's frames when they come with RPC files, and says when angles could not be checked", async () => {
    const { sub, names } = await put({ "clip.mp4": "x", "f001.tif": "x", "f001_RPC.TXT": "r", "f050.tif": "x", "f050_RPC.TXT": "r" });
    const r = await satellitePreflight(sub, names);
    expect(r.problem).toBeNull();
    expect(r.warnings).toEqual(["satVideoIgnored", "satNoAngles"]);
  });
});
