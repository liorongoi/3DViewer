import type { LayerManifest, ManifestLayer } from "@viewer/shared";
import { walk, type Layer } from "./layers";

/**
 * The producer's layer editor (WP 4.3, UPL-09) works on this tree: each layer has a name, the
 * glTF nodes it stands for (several after a merge, none for a group made to hold others) and
 * its child layers. It is made from the file's own tree and the saved manifest, and saved back
 * as a manifest, which applyManifest turns into what everyone sees.
 */
export interface EditLayer {
  /** Stable while editing; not saved. */
  key: string;
  name: string;
  nodes: number[];
  children: EditLayer[];
}

let next = 0;
const key = () => `e${++next}`;

/** The tree as the manifest arranges the file's parts, in a form that can be edited. */
export function editableTree(derived: Layer[], manifest: LayerManifest | null | undefined): EditLayer[] {
  const byNode = new Map<number, Layer>();
  walk(derived, (l) => {
    if (l.node !== undefined) byNode.set(l.node, l);
  });
  const claimed = new Set<number>();
  const claim = (ms: ManifestLayer[]) => ms.forEach((m) => (m.nodes?.forEach((n) => byNode.has(n) && claimed.add(n)), claim(m.children ?? [])));
  claim(manifest?.layers ?? []);
  // A part of the file, with its own parts that the manifest does not place elsewhere.
  const fromFile = (l: Layer): EditLayer[] => {
    const kids = l.children.flatMap((c) => (c.node !== undefined && claimed.has(c.node) ? [] : fromFile(c)));
    // A layer of the file that is not a node (a tileset's root) stands for its parts.
    if (l.node === undefined && !l.nodes?.length) return kids;
    return [{ key: key(), name: l.name, nodes: l.node !== undefined ? [l.node] : [...(l.nodes ?? [])], children: kids }];
  };
  const fromManifest = (m: ManifestLayer): EditLayer | null => {
    const own = (m.nodes ?? []).filter((n) => byNode.has(n));
    const kids = (m.children ?? []).map(fromManifest).filter((l): l is EditLayer => !!l);
    if (!own.length && !kids.length) return null;
    // One part keeps its own unplaced parts below it, as applyManifest shows them.
    const below = own.length === 1 ? byNode.get(own[0]!)!.children.flatMap((c) => (c.node !== undefined && claimed.has(c.node) ? [] : fromFile(c))) : [];
    const name = typeof m.name === "string" && m.name.trim() ? m.name.trim() : (byNode.get(own[0]!)?.name ?? "Layer");
    return { key: key(), name, nodes: own, children: [...kids, ...below] };
  };
  const arranged = (manifest?.layers ?? []).map(fromManifest).filter((l): l is EditLayer => !!l);
  const rest = derived.flatMap((l) => (l.node !== undefined && claimed.has(l.node) ? [] : fromFile(l)));
  return [...arranged, ...rest];
}

/** The manifest to save. Layers with no part and no child layers are left out. */
export function toManifest(tree: EditLayer[]): LayerManifest {
  const out = (ls: EditLayer[]): ManifestLayer[] =>
    ls.flatMap((l) => {
      const children = out(l.children);
      if (!l.nodes.length && !children.length) return [];
      return [{ name: l.name.trim() || "Layer", ...(l.nodes.length ? { nodes: [...l.nodes] } : {}), ...(children.length ? { children } : {}) }];
    });
  return { layers: out(tree) };
}

export function findEdit(tree: EditLayer[], k: string): EditLayer | undefined {
  for (const l of tree) {
    if (l.key === k) return l;
    const f = findEdit(l.children, k);
    if (f) return f;
  }
  return undefined;
}

const without = (tree: EditLayer[], keys: Set<string>): EditLayer[] => tree.filter((l) => !keys.has(l.key)).map((l) => ({ ...l, children: without(l.children, keys) }));

export function renameLayer(tree: EditLayer[], k: string, name: string): EditLayer[] {
  return tree.map((l) => (l.key === k ? { ...l, name } : { ...l, children: renameLayer(l.children, k, name) }));
}

/**
 * Moves a layer before or after another, or inside it as its last child. Nothing changes when
 * the target is the layer itself or one of its own children.
 */
export function moveLayer(tree: EditLayer[], k: string, target: string, where: "before" | "after" | "inside"): EditLayer[] {
  const moving = findEdit(tree, k);
  if (!moving || k === target || findEdit(moving.children, target)) return tree;
  const rest = without(tree, new Set([k]));
  const put = (ls: EditLayer[]): EditLayer[] =>
    ls.flatMap((l) => {
      if (l.key !== target) return [{ ...l, children: put(l.children) }];
      if (where === "inside") return [{ ...l, children: [...l.children, moving] }];
      return where === "before" ? [moving, l] : [l, moving];
    });
  return put(rest);
}

/** Moves a layer one place up or down among its siblings. */
export function shiftLayer(tree: EditLayer[], k: string, by: -1 | 1): EditLayer[] {
  const i = tree.findIndex((l) => l.key === k);
  if (i >= 0) {
    const j = i + by;
    if (j < 0 || j >= tree.length) return tree;
    const out = [...tree];
    [out[i], out[j]] = [out[j]!, out[i]!];
    return out;
  }
  return tree.map((l) => ({ ...l, children: shiftLayer(l.children, k, by) }));
}

/** Nests a layer in the sibling above it, or (out) moves it after its parent. */
export function nestLayer(tree: EditLayer[], k: string, out: boolean): EditLayer[] {
  const parentOf = (ls: EditLayer[], p: EditLayer | null): { parent: EditLayer | null; siblings: EditLayer[] } | null => {
    for (const l of ls) {
      if (l.key === k) return { parent: p, siblings: ls };
      const f = parentOf(l.children, l);
      if (f) return f;
    }
    return null;
  };
  const at = parentOf(tree, null);
  if (!at) return tree;
  if (out) return at.parent ? moveLayer(tree, k, at.parent.key, "after") : tree;
  const i = at.siblings.findIndex((l) => l.key === k);
  return i > 0 ? moveLayer(tree, k, at.siblings[i - 1]!.key, "inside") : tree;
}

/**
 * Merges layers into one, where the first of them stands: it keeps the first one's name and
 * switches all their parts together; their child layers stay, below it.
 */
export function mergeLayers(tree: EditLayer[], keys: string[]): EditLayer[] {
  // A layer inside another being merged goes with it.
  const picked = keys.map((k) => findEdit(tree, k)).filter((l): l is EditLayer => !!l);
  const top = picked.filter((l) => !picked.some((o) => o !== l && findEdit(o.children, l.key)));
  if (top.length < 2) return tree;
  const order: EditLayer[] = [];
  walkEdit(tree, (l) => top.includes(l) && order.push(l));
  const merged: EditLayer = { key: key(), name: order[0]!.name, nodes: [...new Set(order.flatMap((l) => l.nodes))], children: order.flatMap((l) => l.children) };
  const first = order[0]!.key;
  const rest = new Set(order.slice(1).map((l) => l.key));
  const put = (ls: EditLayer[]): EditLayer[] => ls.filter((l) => !rest.has(l.key)).map((l) => (l.key === first ? merged : { ...l, children: put(l.children) }));
  return put(tree);
}

/** A new empty layer at the top, to gather others in. */
export function addGroup(tree: EditLayer[], name: string): { tree: EditLayer[]; key: string } {
  const g: EditLayer = { key: key(), name, nodes: [], children: [] };
  return { tree: [g, ...tree], key: g.key };
}

/**
 * Gathers the layers under the standard names (Terrain, Buildings, ...) the suggestion gives
 * each, at the first level with more than one layer: a file whose parts all sit under one root
 * keeps the root, with the groups inside it. A layer that already has a standard name is that group.
 */
export function groupByStandard(tree: EditLayer[], suggest: (name: string) => string, standard: readonly string[]): EditLayer[] {
  if (tree.length === 1 && tree[0]!.children.length > 1) return [{ ...tree[0]!, children: groupByStandard(tree[0]!.children, suggest, standard) }];
  const groups = new Map<string, EditLayer>();
  const out: EditLayer[] = [];
  const groupFor = (name: string) => {
    let g = groups.get(name);
    if (!g) {
      g = { key: key(), name, nodes: [], children: [] };
      groups.set(name, g);
      out.push(g);
    }
    return g;
  };
  for (const l of tree) {
    if (standard.includes(l.name.trim())) {
      const g = groupFor(l.name.trim());
      g.nodes.push(...l.nodes);
      g.children.push(...l.children);
    } else groupFor(suggest(l.name)).children.push(l);
  }
  // In the standard list's order.
  return out.sort((a, b) => standard.indexOf(a.name) - standard.indexOf(b.name));
}

export function walkEdit(tree: EditLayer[], fn: (l: EditLayer) => void): void {
  for (const l of tree) {
    fn(l);
    walkEdit(l.children, fn);
  }
}
