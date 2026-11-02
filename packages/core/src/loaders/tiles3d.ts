import { ecefToGeodetic } from "../geo/wgs84";
import { baseName, ext, resolvePath, type FileSet, type LocalFile } from "./files";
import { checkGltfDoc, parseGlb, parseJson } from "./gltf";
import type { CheckItem, LoaderPlugin } from "./types";

interface Tile {
  content?: { uri?: string; url?: string };
  contents?: { uri?: string; url?: string }[];
  children?: Tile[];
  boundingVolume?: { region?: number[]; box?: number[]; sphere?: number[] };
  transform?: number[];
  geometricError?: number;
  implicitTiling?: unknown;
}
interface Tileset {
  asset?: { version?: string };
  geometricError?: number;
  root?: Tile;
}

const MAGICS: Record<string, string> = { b3dm: "Batched 3D Model", i3dm: "Instanced 3D Model", pnts: "Point cloud", cmpt: "Composite", glTF: "glTF" };

const contentUris = (t: Tile): string[] =>
  [t.content, ...(t.contents ?? [])].flatMap((c) => (c ? [c.uri ?? c.url ?? ""] : [])).filter(Boolean);

function isTileset(json: unknown): json is Tileset {
  return !!json && typeof json === "object" && "asset" in json && "root" in json;
}

/** Walks a tileset and every external tileset it references. */
async function walk(
  path: string,
  files: FileSet,
  visit: (tile: Tile, from: string) => void | Promise<void>,
  seen = new Set<string>(),
): Promise<void> {
  if (seen.has(path)) return;
  seen.add(path);
  const f = files.get(path);
  if (!f) return;
  const ts = parseJson<Tileset>(await f.bytes(), "tileset");
  const stack: Tile[] = ts.root ? [ts.root] : [];
  while (stack.length) {
    const t = stack.pop()!;
    await visit(t, path);
    for (const uri of contentUris(t)) {
      const p = resolvePath(path, uri);
      if (p && ext(p) === "json" && files.get(p)) await walk(p, files, visit, seen);
    }
    stack.push(...(t.children ?? []));
  }
}

function georefOf(ts: Tileset): { lat: number; lon: number; height: number } | null {
  const root = ts.root;
  if (!root) return null;
  const r = root.boundingVolume?.region;
  if (r && r.length >= 6) return { lon: ((r[0]! + r[2]!) / 2) * (180 / Math.PI), lat: ((r[1]! + r[3]!) / 2) * (180 / Math.PI), height: r[4]! };
  const m = root.transform;
  let c = root.boundingVolume?.box?.slice(0, 3) ?? root.boundingVolume?.sphere?.slice(0, 3);
  if (m && m.length === 16 && c) c = [m[0]! * c[0]! + m[4]! * c[1]! + m[8]! * c[2]! + m[12]!, m[1]! * c[0]! + m[5]! * c[1]! + m[9]! * c[2]! + m[13]!, m[2]! * c[0]! + m[6]! * c[1]! + m[10]! * c[2]! + m[14]!];
  if (!c || Math.hypot(c[0]!, c[1]!, c[2]!) < 6.0e6) return null;
  const g = ecefToGeodetic({ x: c[0]!, y: c[1]!, z: c[2]! });
  return { lat: g.lat, lon: g.lon, height: g.height };
}

export const tiles3dLoader: LoaderPlugin = {
  id: "3dtiles",
  format: "3dtiles",
  main(files) {
    const jsons = files.files.filter((f) => ext(f.path) === "json").sort((a, b) => a.path.split("/").length - b.path.split("/").length);
    return jsons.find((f) => baseName(f.path).toLowerCase() === "tileset.json") ?? null;
  },
  async check(main, files) {
    const items: CheckItem[] = [];
    const stats = { files: files.files.length, bytes: files.bytes, tiles: 0, contents: 0 };
    let ts: Tileset;
    try {
      const json = parseJson<unknown>(await main.bytes(), "tileset");
      if (!isTileset(json)) throw new Error("It has no asset or root, so it is not a 3D Tiles tileset.");
      ts = json;
    } catch (e) {
      return { items: [{ id: "format", severity: "error", title: `${baseName(main.path)} cannot be read`, detail: (e as Error).message }], stats, nodes: [], georef: null };
    }
    const v = ts.asset?.version ?? "";
    if (v === "1.0" || v === "1.1") items.push({ id: "format", severity: "ok", title: `3D Tiles ${v}` });
    else items.push({ id: "format", severity: "error", title: v ? `3D Tiles version ${v} is not supported` : "The tileset has no asset version", detail: "Versions 1.0 and 1.1 can be opened." });
    if (typeof ts.geometricError !== "number" || !ts.root?.boundingVolume)
      items.push({ id: "structure", severity: "error", title: "The tileset is incomplete", detail: "It needs a geometric error and a root bounding volume." });

    const missing: string[] = [];
    const contents: { path: string; from: string }[] = [];
    let implicit = false;
    const badJson: string[] = [];
    try {
      await walk(main.path, files, (t, from) => {
        stats.tiles++;
        if (t.implicitTiling) implicit = true;
        for (const uri of contentUris(t)) {
          if (uri.includes("{level}")) continue;
          const p = resolvePath(from, uri);
          if (!p || !files.get(p)) missing.push(uri);
          else if (ext(p) !== "json") contents.push({ path: p, from });
        }
      });
    } catch (e) {
      badJson.push((e as Error).message);
    }
    stats.contents = contents.length;
    if (badJson.length) items.push({ id: "structure", severity: "error", title: "An external tileset cannot be read", detail: badJson.join("; ") });
    if (missing.length)
      items.push({
        id: "references",
        severity: "error",
        title: `${missing.length} tile file${missing.length > 1 ? "s are" : " is"} missing`,
        detail: missing.length > 8 ? `${missing.slice(0, 8).join(", ")} and ${missing.length - 8} more` : missing.join(", "),
      });
    else items.push({ id: "references", severity: "ok", title: `All ${contents.length} tile files are present` });
    if (implicit) items.push({ id: "structure", severity: "warning", title: "Uses implicit tiling", detail: "Its tile files are found while viewing; open it in the desktop app or from the server." });

    // Read every content header (up to 400) so a damaged tile is named, not discovered while flying.
    const kinds = new Map<string, number>();
    const damaged: string[] = [];
    for (const c of contents.slice(0, 400)) {
      const f = files.get(c.path)!;
      const head = await f.bytes();
      const magic = new TextDecoder().decode(head.subarray(0, 4));
      if (!MAGICS[magic] && ext(c.path) !== "gltf") {
        damaged.push(`${c.path} (starts with "${magic.replace(/[^\x20-\x7e]/g, "?")}")`);
        continue;
      }
      kinds.set(MAGICS[magic] ?? "glTF", (kinds.get(MAGICS[magic] ?? "glTF") ?? 0) + 1);
      if (magic === "glTF") {
        try {
          const glb = parseGlb(head);
          const sub = await checkGltfDoc(glb.json, c.path, files, glb.bin?.byteLength ?? null);
          for (const s of sub.filter((x) => x.severity === "error")) damaged.push(`${c.path}: ${s.title}`);
        } catch (e) {
          damaged.push(`${c.path}: ${(e as Error).message}`);
        }
      }
    }
    if (damaged.length)
      items.push({ id: "content", severity: "error", title: `${damaged.length} tile file${damaged.length > 1 ? "s are" : " is"} damaged`, detail: damaged.slice(0, 6).join("; ") + (damaged.length > 6 ? ` and ${damaged.length - 6} more` : "") });
    else if (kinds.size) items.push({ id: "content", severity: "ok", title: [...kinds].map(([k, n]) => `${n} ${k}`).join(", ") });

    return { items, stats, nodes: [], georef: georefOf(ts) };
  },
  async prepare(main, files, url) {
    const done = new Map<string, string>();
    const blobOf = async (f: LocalFile): Promise<string> => {
      const hit = done.get(f.path);
      if (hit) return hit;
      const u = ext(f.path) === "json" ? await rewrite(f) : url(await f.bytes());
      done.set(f.path, u);
      return u;
    };
    const rewrite = async (f: LocalFile): Promise<string> => {
      const ts = parseJson<Tileset>(await f.bytes(), "tileset");
      const stack: Tile[] = ts.root ? [ts.root] : [];
      while (stack.length) {
        const t = stack.pop()!;
        for (const c of [t.content, ...(t.contents ?? [])]) {
          const uri = c?.uri ?? c?.url;
          if (!c || !uri) continue;
          const p = resolvePath(f.path, uri);
          const target = p ? files.get(p) : undefined;
          if (!target) continue;
          const u = await blobOf(target);
          if (c.uri !== undefined) c.uri = u;
          else c.url = u;
        }
        stack.push(...(t.children ?? []));
      }
      return url(JSON.stringify(ts), "application/json");
    };
    return blobOf(main);
  },
};
