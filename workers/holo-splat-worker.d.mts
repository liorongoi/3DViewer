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
export function readImages(buf: Buffer): { at: number; name: string; q: number[]; t: V3; centre: V3; cameraId: number }[];
export interface Camera { model: number; width: number; height: number; params: number[] }
export function readCameras(buf: Buffer): Map<number, Camera>;
/** A pixel as an undistorted direction (x, y, 1) in its camera, or null for a camera model not handled. */
export function pixelRay(cam: Camera, px: number, py: number): V3 | null;
export function triangulate(rays: { o: V3; d: V3 }[]): { point: V3; widestDeg: number } | null;
export interface GroundControlFile { crs: string; points: { name: string; lat: number; lon: number; height: number; observations: { image: string; x: number; y: number }[] }[] }
/** Placement from surveyed ground control points seen in posed pictures. */
export function controlPlacement(
  images: { name: string; q: number[]; centre: V3; cameraId: number }[],
  cameras: Map<number, Camera>,
  gc: GroundControlFile,
): { reason: string; skipped: string[] } | { T: Sim; skipped: string[]; georef: { origin: { lat: number; lon: number; height: number }; source: string; metresPerModelUnit: number; controls: Res; checks: Res | null; horizontalCrs: string; verticalDatum: string } };
export function transformModel(dir: string, T: Sim): void;
export function georeference(
  cameras: { name: string; centre: V3 }[],
  fixes: Map<string, Fix>,
  source: string,
): { reason: string } | { T: Sim; georef: { origin: { lat: number; lon: number; height: number }; metresPerModelUnit: number; controls: Res; checks: Res | null; source: string } };
export function frameMotion(a: Uint8Array, b: Uint8Array, w: number, h: number, block?: number, search?: number): number;
export function selectFrames(triggers: number[], n: number, blur: Map<number, number>, opts: { maxGap: number; window?: number }): number[];
export function parseFrameScores(text: string): { blur: Map<number, number>; times: number[] };
export function loadConfig(file?: string): Record<string, unknown>;
export function videoFrames(cfg: Record<string, unknown>, video: string, dir: string, o: { resolution: number; videoFps: number }): Promise<{ name: string; time: number }[]>;
export function jpegSplitter(onImage: (jpg: Buffer, n: number) => void): (chunk: Buffer) => void;

/** The least turn (and shift to the cameras' middle) that makes up the viewer's up, for a model with no placement. */
export function levelTransform(cams: { q: number[]; centre: V3 }[]): { T: Sim; tiltDeg: number; reason?: undefined } | { reason: string; T?: undefined };
/** About a twentieth of a training run, dividing it exactly. */
export function exportStep(iterations: number): number;
