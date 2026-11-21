import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseGroundControl, prepareGroundControl } from "./ground-control.ts";

describe("ground control file (gcp_list.txt)", () => {
  it("reads Israeli TM Grid points and groups sightings by point", () => {
    // PROJ's own answer (core/src/geo/fixtures/proj-reference.json): Mount Hermon, WGS 84 33.4163 N 35.8572 E.
    const gc = parseGroundControl(["EPSG:2039", "280171.881 813577.484 2000.0 100 200 IMG_1.JPG gcp1", "280171.881 813577.484 2000.0 150 210 IMG_2.JPG gcp1", "280271.881 813577.484 2001.5 300 400 IMG_1.JPG gcp2"].join("\n"));
    expect(gc.crs).toBe("EPSG:2039");
    expect(gc.points).toHaveLength(2);
    const [a, b] = gc.points;
    expect(a!.observations).toHaveLength(2);
    expect(Math.abs(a!.lat - 33.4163) * 111_000).toBeLessThan(0.1);
    expect(Math.abs(a!.lon - 35.8572) * 93_000).toBeLessThan(0.1);
    expect(a!.height).toBe(2000);
    // 100 m east on the grid.
    expect((b!.lon - a!.lon) * 93_000).toBeGreaterThan(99);
    expect((b!.lon - a!.lon) * 93_000).toBeLessThan(101);
  });

  it("reads UTM and longitude-latitude headers, and points with no name", () => {
    const utm = parseGroundControl("WGS84 UTM 36N\n# a comment\n700000 3550000 10 1 2 a.jpg\n700000 3550000 10 3 4 b.jpg\n");
    expect(utm.points).toHaveLength(1);
    expect(utm.points[0]!.observations.map((o) => o.image)).toEqual(["a.jpg", "b.jpg"]);
    const ll = parseGroundControl("EPSG:4326\n34.78 32.08 40 5 6 dir/c.tif p");
    expect(ll.points[0]).toMatchObject({ lat: 32.08, lon: 34.78, observations: [{ image: "c.tif", x: 5, y: 6 }] });
  });

  it("says what to fix", () => {
    expect(() => parseGroundControl("219529 626907 800 1 2 a.jpg")).toThrow(/first line .* coordinate system/);
    expect(() => parseGroundControl("EPSG:2039\n1 2 3 4 a.jpg")).toThrow(/Line 2/);
    expect(() => parseGroundControl("EPSG:2039\n219529 626907 800 1 2 a.jpg p\n219600 626907 800 1 2 b.jpg p")).toThrow(/two different positions/);
    expect(() => parseGroundControl("EPSG:99999\n1 2 3 4 5 a.jpg")).toThrow(/EPSG:99999/);
  });

  it("writes ground-control.json for the worker, and nothing when there is no file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "gcp-"));
    try {
      const out = path.join(dir, "ground-control.json");
      expect(await prepareGroundControl(dir, ["a.jpg"], out)).toBeNull();
      await writeFile(path.join(dir, "GCP_List.txt"), "EPSG:4326\n34.78 32.08 40 5 6 a.jpg p\n");
      const gc = await prepareGroundControl(dir, ["a.jpg", "GCP_List.txt"], out);
      expect(gc!.points).toHaveLength(1);
      expect(JSON.parse(await readFile(out, "utf8")).points[0].name).toBe("p");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
