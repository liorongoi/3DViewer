import type { SightPair } from "./sightline";

/** CSV export of line-of-sight results (plan WP 2.8). Comma separated, UTF-8, header row. */

const f = (v: number, d: number) => (Number.isFinite(v) ? v.toFixed(d) : "");
const q = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);

/** One row per pair: positions, heights, result and the first obstruction. */
export function pairsToCsv(pairs: SightPair[]): string {
  const head = [
    "name", "a_lat", "a_lon", "a_ground_m", "a_above_ground_m", "b_lat", "b_lon", "b_ground_m", "b_above_ground_m",
    "distance_m", "visible", "first_obstruction_m", "obstruction_lat", "obstruction_lon", "worst_deficit_m",
  ];
  const rows = pairs.map((p) => [
    q(p.name), f(p.a.lat, 7), f(p.a.lon, 7), f(p.a.h, 2), f(p.aHeight, 2), f(p.b.lat, 7), f(p.b.lon, 7), f(p.b.h, 2), f(p.bHeight, 2),
    f(p.distance, 2), p.visible === null ? "" : p.visible ? "yes" : "no",
    p.block ? f(p.block.d, 2) : "", p.block ? f(p.block.lat, 7) : "", p.block ? f(p.block.lon, 7) : "", f(p.worstDeficit, 2),
  ]);
  return [head, ...rows].map((r) => r.join(",")).join("\n") + "\n";
}

/** The height profile of one pair, one row per sample. */
export function profileToCsv(p: SightPair): string {
  const head = ["distance_m", "lat", "lon", "ground_m", "surface_m", "sight_line_m", "clearance_m"];
  const rows = p.profile.map((s) => [f(s.d, 2), f(s.lat, 7), f(s.lon, 7), f(s.ground, 2), f(s.surface, 2), f(s.sight, 2), f(s.sight - s.surface, 2)]);
  return [head, ...rows].map((r) => r.join(",")).join("\n") + "\n";
}
