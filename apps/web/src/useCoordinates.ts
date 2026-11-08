import { formatCoordinate, utmZoneFor, type FormattedCoordinate } from "@viewer/core";
import { useEngine, useSignal } from "./engine";
import { useApp } from "./state/store";

/**
 * The UTM zone coordinates are shown in (MSR-08): the one the user chose, or the open model's
 * own zone, so every point of a model reads in one grid even where it crosses a zone line.
 * Undefined with no model open and no choice: each point then takes its own zone.
 */
export function useUtmZone(): { zone: number | undefined; auto: boolean } {
  const engine = useEngine();
  const model = useSignal(engine?.current, null);
  const pref = useApp((s) => s.utmZone);
  const chosen = Number(pref);
  if (pref !== "auto" && Number.isInteger(chosen) && chosen >= 1 && chosen <= 60) return { zone: chosen, auto: false };
  return { zone: model ? utmZoneFor(model.centre.lat, model.centre.lon) : undefined, auto: true };
}

/** Formats a position in the coordinate system and zone the user chose. */
export function useCoordinates(): (lat: number, lon: number, height: number) => FormattedCoordinate {
  const system = useApp((s) => s.coordSystem);
  const { zone } = useUtmZone();
  return (lat, lon, height) => formatCoordinate(lat, lon, height, system, zone);
}
