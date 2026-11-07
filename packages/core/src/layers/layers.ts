import type { LayerManifest, ManifestLayer } from "@viewer/shared";
import { gltfNodeBoxes, type GltfBox } from "../loaders/gltf";

// Layer tree derived from a model (SRS 6.3): glTF node hierarchy, or one layer per tileset.

export interface Layer {
  id: string;
  name: string;
  /** Name used to find the node in the renderer; undefined when the node is not addressable. */
  nodeName?: string;
  children: Layer[];
  /** The layer's own toggle. Effective visibility also depends on its ancestors. */
  visible: boolean;
  /** glTF node index the layer stands for. */
  node?: number;
  /** Every glTF node a layer stands for, when it is more than one (parts merged by a manifest). */
  nodes?: number[];
  /** Extent in the glTF scene's own coordinates, for Focus selection. */
  box?: GltfBox;
}

interface GltfNode {
  name?: string;
  mesh?: number;
  children?: number[];
}

interface GltfJson {
  scene?: number;
  scenes?: { nodes?: number[] }[];
  nodes?: GltfNode[];
  meshes?: { name?: string; primitives?: { attributes?: Record<string, number> }[] }[];
  accessors?: { min?: number[]; max?: number[] }[];
}

/** Builds the layer tree from glTF JSON. Nodes without a mesh anywhere below them are skipped. */
export function layersFromGltf(gltf: GltfJson): Layer[] {
  const nodes = gltf.nodes ?? [];
  const boxes = gltfNodeBoxes(gltf as Parameters<typeof gltfNodeBoxes>[0]);
  const scene = gltf.scenes?.[gltf.scene ?? 0];
  const roots = scene?.nodes ?? nodes.map((_, i) => i);
  const nameCount = new Map<string, number>();
  for (const n of nodes) if (n.name) nameCount.set(n.name, (nameCount.get(n.name) ?? 0) + 1);

  const hasMesh = (i: number, seen = new Set<number>()): boolean => {
    if (seen.has(i)) return false;
    seen.add(i);
    const n = nodes[i];
    if (!n) return false;
    return n.mesh !== undefined || (n.children ?? []).some((c) => hasMesh(c, seen));
  };

  const build = (i: number, depth: number): Layer | null => {
    const n = nodes[i];
    if (!n || depth > 64 || !hasMesh(i)) return null;
    const meshName = n.mesh !== undefined ? gltf.meshes?.[n.mesh]?.name : undefined;
    const unique = n.name !== undefined && nameCount.get(n.name) === 1;
    const children = (n.children ?? []).map((c) => build(c, depth + 1)).filter((x): x is Layer => !!x);
    return {
      id: `node-${i}`,
      name: n.name || meshName || `Node ${i}`,
      nodeName: unique ? n.name : undefined,
      children,
      visible: true,
      node: i,
      box: boxes.get(i),
    };
  };

  const tree = roots.map((r) => build(r, 0)).filter((x): x is Layer => !!x);
  // A single unnamed wrapper node adds nothing: show its children directly.
  if (tree.length === 1 && tree[0]!.children.length > 0 && !tree[0]!.nodeName) return tree[0]!.children;
  return tree;
}

interface TiledLayerJson {
  id?: unknown;
  name?: unknown;
  node?: unknown;
  box?: { lo?: unknown; hi?: unknown };
  children?: unknown;
}

/**
 * The layer tree a tileset from our tiler carries in its extras (apps/server/src/tiler.ts):
 * the original model's parts, with ids and boxes as for a single model. Null when the
 * tileset has none, or it is not in that shape.
 */
export function layersFromTileset(extras: unknown): Layer[] | null {
  const raw = (extras as { layers?: unknown } | undefined)?.layers;
  if (!Array.isArray(raw) || !raw.length) return null;
  const vec = (v: unknown) => (Array.isArray(v) && v.length === 3 && v.every((x) => Number.isFinite(x)) ? (v as [number, number, number]) : null);
  const read = (j: TiledLayerJson, depth: number): Layer | null => {
    if (depth > 64 || typeof j !== "object" || !j || !Number.isInteger(j.node)) return null;
    const lo = vec(j.box?.lo), hi = vec(j.box?.hi);
    const kids = Array.isArray(j.children) ? j.children.map((c) => read(c as TiledLayerJson, depth + 1)) : [];
    if (kids.some((k) => !k)) return null;
    const node = j.node as number;
    return { id: `node-${node}`, name: typeof j.name === "string" && j.name ? j.name : `Node ${node}`, node, children: kids as Layer[], visible: true, ...(lo && hi ? { box: { lo, hi } } : {}) };
  };
  const out = raw.map((j) => read(j as TiledLayerJson, 0));
  return out.every((l) => !!l) ? (out as Layer[]) : null;
}

export function walk(layers: Layer[], fn: (l: Layer, parent?: Layer) => void, parent?: Layer): void {
  for (const l of layers) {
    fn(l, parent);
    walk(l.children, fn, l);
  }
}

export function findLayer(layers: Layer[], id: string): Layer | undefined {
  let found: Layer | undefined;
  walk(layers, (l) => {
    if (l.id === id) found = l;
  });
  return found;
}

/** Returns a copy with the given layer's own visibility changed. */
export function setVisible(layers: Layer[], id: string, visible: boolean): Layer[] {
  return layers.map((l) =>
    l.id === id ? { ...l, visible } : { ...l, children: setVisible(l.children, id, visible) },
  );
}

export function setAllVisible(layers: Layer[], visible: boolean): Layer[] {
  return layers.map((l) => ({ ...l, visible, children: setAllVisible(l.children, visible) }));
}

/** Isolate: only the layer, its ancestors and its descendants stay visible. */
export function isolate(layers: Layer[], id: string): Layer[] {
  const path = new Set<string>();
  const findPath = (ls: Layer[], trail: string[]): boolean => {
    for (const l of ls) {
      if (l.id === id || findPath(l.children, [...trail, l.id])) {
        for (const t of [...trail, l.id]) path.add(t);
        return true;
      }
    }
    return false;
  };
  findPath(layers, []);
  const apply = (ls: Layer[], inside: boolean): Layer[] =>
    ls.map((l) => {
      const isTarget = l.id === id;
      const visible = inside || path.has(l.id);
      return { ...l, visible, children: apply(l.children, inside || isTarget) };
    });
  return apply(layers, false);
}

/** Effective visibility per layer id (hidden if any ancestor is hidden). */
export function effectiveVisibility(layers: Layer[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  const rec = (ls: Layer[], parentVisible: boolean) => {
    for (const l of ls) {
      const v = parentVisible && l.visible;
      out.set(l.id, v);
      rec(l.children, v);
    }
  };
  rec(layers, true);
  return out;
}

export function filterLayers(layers: Layer[], query: string): Layer[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return layers;
  const rec = (ls: Layer[]): Layer[] =>
    ls.flatMap((l) => {
      const kids = rec(l.children);
      if (l.name.toLocaleLowerCase().includes(q) || kids.length) return [{ ...l, children: kids }];
      return [];
    });
  return rec(layers);
}

/** The glTF nodes a layer shows and hides itself (its child layers have their own). */
export const layerNodes = (l: Layer): number[] => l.nodes ?? (l.node !== undefined ? [l.node] : []);

/** The layer that stands for a glTF node: the node's own, or that of its nearest ancestor that is a layer. */
export function layerForNode(layers: Layer[], gltfNodes: { children?: number[] }[], node: number): Layer | undefined {
  const byNode = new Map<number, Layer>();
  walk(layers, (l) => {
    for (const n of layerNodes(l)) byNode.set(n, l);
  });
  const parent = new Map<number, number>();
  gltfNodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));
  for (let i: number | undefined = node, guard = 0; i !== undefined && guard < 65; i = parent.get(i), guard++) {
    const l = byNode.get(i);
    if (l) return l;
  }
  return undefined;
}

// ---------------------------------------------------------------- saved layer manifest (WP 2.1)

export type { LayerManifest, ManifestLayer };

const unionBox = (boxes: (GltfBox | undefined)[]): GltfBox | undefined => {
  const bs = boxes.filter((b): b is GltfBox => !!b);
  if (!bs.length) return undefined;
  return {
    lo: [0, 1, 2].map((k) => Math.min(...bs.map((b) => b.lo[k]!))) as GltfBox["lo"],
    hi: [0, 1, 2].map((k) => Math.max(...bs.map((b) => b.hi[k]!))) as GltfBox["hi"],
  };
};

/**
 * The layer tree as the manifest arranges it. A layer of one node keeps that node's id and
 * its own parts below it; a layer of several nodes (a merge) is one layer for all of them.
 * Parts the manifest does not mention keep their place in the file's own tree, after the
 * manifest's layers, so a newer version with new parts still shows them. Node numbers the
 * model does not have are ignored.
 */
export function applyManifest(derived: Layer[], manifest: LayerManifest | null | undefined): Layer[] {
  if (!manifest?.layers?.length) return derived;
  const byNode = new Map<number, Layer>();
  walk(derived, (l) => {
    if (l.node !== undefined) byNode.set(l.node, l);
  });
  const claimed = new Set<number>();
  const claim = (ms: ManifestLayer[]) => ms.forEach((m) => (m.nodes?.forEach((n) => byNode.has(n) && claimed.add(n)), claim(m.children ?? [])));
  claim(manifest.layers);
  // A derived layer without the parts claimed elsewhere.
  const prune = (l: Layer): Layer => ({ ...l, visible: true, children: l.children.filter((c) => c.node === undefined || !claimed.has(c.node)).map(prune) });
  // Every node under a layer that is not claimed elsewhere: what a merged layer switches.
  const covered = (l: Layer, out: number[]) => {
    if (l.node !== undefined) out.push(l.node);
    for (const c of l.children) if (c.node === undefined || !claimed.has(c.node)) covered(c, out);
    return out;
  };
  const build = (m: ManifestLayer, path: string): Layer | null => {
    const own = (m.nodes ?? []).map((n) => byNode.get(n)).filter((l): l is Layer => !!l);
    const kids = (m.children ?? []).map((c, i) => build(c, `${path}.${i}`)).filter((l): l is Layer => !!l);
    if (!own.length && !kids.length) return null;
    const name = typeof m.name === "string" && m.name.trim() ? m.name.trim() : own[0]?.name ?? "Layer";
    if (own.length === 1) {
      const l = prune(own[0]!);
      return { ...l, name, children: [...kids, ...l.children] };
    }
    const nodes = own.flatMap((l) => covered(l, []));
    return { id: `group-${path}`, name, visible: true, children: kids, ...(nodes.length ? { nodes } : {}), box: unionBox([...own.map((l) => l.box), ...kids.map((k) => k.box)]) };
  };
  const arranged = manifest.layers.map((m, i) => build(m, String(i))).filter((l): l is Layer => !!l);
  // Parts the manifest leaves out: where the file has them, without the claimed ones.
  const rest = (ls: Layer[]): Layer[] => ls.flatMap((l) => (l.node !== undefined && claimed.has(l.node) ? [] : [prune(l)]));
  return [...arranged, ...rest(derived)];
}
