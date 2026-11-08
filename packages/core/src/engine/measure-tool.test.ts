import { describe, expect, it } from "vitest";
import { Cartesian3, EntityCollection } from "cesium";
import { MeasureTool } from "./measure-tool";

const at = (lon: number, lat: number, h: number) => Cartesian3.fromDegrees(lon, lat, h);

function tool() {
  const entities = new EntityCollection();
  const m = new MeasureTool(entities, () => undefined);
  const distance = (a: Cartesian3, b: Cartesian3) => {
    m.start("distance");
    m.addPoint(a);
    m.addPoint(b);
  };
  return { m, entities, distance };
}

describe("MeasureTool (MSR-04, MSR-05)", () => {
  it("names, renames, hides and deletes measurements, and Ctrl+Z puts one back where it was", () => {
    const { m, entities, distance } = tool();
    distance(at(35.2, 31.7, 800), at(35.2001, 31.7, 810));
    distance(at(35.2, 31.7, 800), at(35.2, 31.7001, 800));
    distance(at(35.2, 31.7, 800), at(35.2002, 31.7, 790));
    expect(m.measurements.get().map((x) => x.label)).toEqual(["Distance 1", "Distance 2", "Distance 3"]);

    const drawn = entities.values.length;
    const second = m.measurements.get()[1]!;
    m.rename(second.id, "Roof edge");
    expect(m.measurements.get()[1]!.label).toBe("Roof edge");

    m.setVisible(second.id, false);
    expect(entities.values.length).toBeLessThan(drawn);
    m.setVisible(second.id, true);
    expect(entities.values.length).toBe(drawn);

    const gone = m.remove(second.id)!;
    expect(gone.index).toBe(1);
    expect(m.measurements.get().map((x) => x.label)).toEqual(["Distance 1", "Distance 3"]);
    expect(entities.values.length).toBeLessThan(drawn);

    expect(m.restore(gone.measurement, gone.index)).toBe(true);
    expect(m.measurements.get().map((x) => x.label)).toEqual(["Distance 1", "Roof edge", "Distance 3"]);
    expect(entities.values.length).toBe(drawn);
    // Twice is once.
    expect(m.restore(gone.measurement, gone.index)).toBe(false);
    expect(m.measurements.get()).toHaveLength(3);
  });

  it("gives the three numbers of the measurement triangle", () => {
    const { m, distance } = tool();
    // 10 m up and about 9.5 m east.
    distance(at(35.2, 31.7, 800), at(35.2001, 31.7, 810));
    const s = m.measurements.get()[0]!.result.segments[0]!;
    expect(s.heightDelta).toBeCloseTo(10, 3);
    expect(s.horizontal).toBeGreaterThan(9.4);
    expect(s.horizontal).toBeLessThan(9.6);
    expect(s.distance3d).toBeCloseTo(Math.hypot(s.horizontal, s.heightDelta), 2);
  });

  it("formats in feet and in model units", () => {
    const { m } = tool();
    m.setUnit("ft");
    expect(m.format(1)).toMatch(/3\.28.*ft/);
    m.setModelUnit(0.5);
    m.modelUnitName = "model units";
    expect(m.format(1)).toMatch(/^2(\.0+)? model units$/);
    m.setModelUnit(null);
    m.setUnit("m");
    expect(m.format(1)).toMatch(/1.*m/);
  });
});
