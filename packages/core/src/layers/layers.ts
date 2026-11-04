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
  meshes?: { name?: string }[];
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

/** The layer that stands for a glTF node: the node's own, or that of its nearest ancestor that is a layer. */
export function layerForNode(layers: Layer[], gltfNodes: { children?: number[] }[], node: number): Layer | undefined {
  const byNode = new Map<number, Layer>();
  walk(layers, (l) => {
    if (l.node !== undefined) byNode.set(l.node, l);
  });
  const parent = new Map<number, number>();
  gltfNodes.forEach((n, i) => n.children?.forEach((c) => parent.set(c, i)));
  for (let i: number | undefined = node, guard = 0; i !== undefined && guard < 65; i = parent.get(i), guard++) {
    const l = byNode.get(i);
    if (l) return l;
  }
  return undefined;
}
