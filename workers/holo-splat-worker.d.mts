// Types for the parts of holo-splat-worker.mjs that the server's tests use.
export type V3 = [number, number, number];
export interface Sim { s: number; R: number[][]; t: V3 }
export interface Fix { lat: number; lon: number; height: number | null }
export interface Res { count: number; horizontalRms: number; verticalRms: number; max: number }
export const DEFAULTS: { methods: Record<string, { train: string[]; check?: string[] }> } & Record<string, unknown>;
export function fill(argv: string[], values: Record<string, unknown>): string[];
export function toEcef(lat: number, lon: number, h: number): V3;
export function toGeodetic(p: V3): { lat: number; lon: number; height: number };
export function toEnu(origin: { lat: number; lon: number; height: number }, lat: number, lon: number, h: number): V3;
export function fitSimilarity(xs: V3[], ys: V3[]): Sim | null;
export function applySim(T: Sim, p: V3): V3;
export function residuals(T: Sim, xs: V3[], ys: V3[]): Res | null;
export function exifGps(buf: Buffer): Fix | null;
export function parseSrt(text: string): (Fix & { t: number })[];
export function parseGnssCsv(text: string): (Fix & { t: number })[];
export function positionAt(track: (Fix & { t: number })[], t: number): Fix | null;
export function readImages(buf: Buffer): { at: number; name: string; q: number[]; t: V3; centre: V3 }[];
export function transformModel(dir: string, T: Sim): void;
export function georeference(
  cameras: { name: string; centre: V3 }[],
  fixes: Map<string, Fix>,
  source: string,
): { reason: string } | { T: Sim; georef: { origin: { lat: number; lon: number; height: number }; metresPerModelUnit: number; controls: Res; checks: Res | null; source: string } };
export function parseBlur(text: string, rate: number): Map<number, number>;
export function pickSharpest<F extends { step: number }>(frames: F[], blur: Map<number, number>, group: number): F[];
