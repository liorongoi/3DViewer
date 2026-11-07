import { describe, expect, it } from "vitest";
import { applyManifest, effectiveVisibility, filterLayers, findLayer, isolate, layerForNode, layerNodes, layersFromGltf, layersFromTileset, setAllVisible, setVisible, walk, type Layer } from "./layers";

const gltf = {
  scenes: [{ nodes: [0] }],
  nodes: [
    { name: "Root", children: [1, 2, 5] },
    { name: "Buildings", children: [3, 4] },
    { name: "Trees", mesh: 2 },
    { name: "Block A", mesh: 0 },
    { name: "Block B", mesh: 1 },
    { name: "Empty helper" },
  ],
  meshes: [{ name: "a" }, { name: "b" }, { name: "t" }],
};

describe("layers", () => {
  it("builds a tree, skipping nodes with no geometry", () => {
    const tree = layersFromGltf(gltf);
    expect(tree).toHaveLength(1);
    expect(tree[0]!.name).toBe("Root");
    expect(tree[0]!.children.map((c) => c.name)).toEqual(["Buildings", "Trees"]);
  });

  it("hides children when a parent is hidden (LYR-02)", () => {
    let t = layersFromGltf(gltf);
    t = setVisible(t, "node-1", false);
    const v = effectiveVisibility(t);
    expect(v.get("node-3")).toBe(false);
    expect(v.get("node-2")).toBe(true);
  });

  it("shows and hides everything (LYR-03)", () => {
    const t = setAllVisible(layersFromGltf(gltf), false);
    expect([...effectiveVisibility(t).values()].every((x) => !x)).toBe(true);
  });

  it("isolates a layer and keeps its ancestors (LYR-05)", () => {
    const v = effectiveVisibility(isolate(layersFromGltf(gltf), "node-3"));
    expect(v.get("node-3")).toBe(true);
    expect(v.get("node-4")).toBe(false);
    expect(v.get("node-2")).toBe(false);
  });

  it("filters by name and keeps the path (LYR-04)", () => {
    const f = filterLayers(layersFromGltf(gltf), "block b");
    expect(f[0]!.children[0]!.children.map((c) => c.name)).toEqual(["Block B"]);
  });
});

describe("focus selection (NAV-05)", () => {
  // Two unit cubes: one at the origin, one moved 10 m along x and doubled by its parent.
  const boxed = {
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: "Site", children: [1, 2] },
      { name: "Hut", mesh: 0 },
      { name: "Yard", translation: [10, 0, 0], scale: [2, 2, 2], children: [3] },
      { name: "Shed", mesh: 0, translation: [1, 0, 0] },
    ],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] }],
  };

  it("gives each layer its box with node transforms applied", () => {
    const [site] = layersFromGltf(boxed);
    expect(site!.box).toEqual({ lo: [-0.5, 0, -1], hi: [13, 2, 1] });
    const yard = findLayer([site!], "node-2")!;
    expect(yard.box).toEqual({ lo: [11, 0, -1], hi: [13, 2, 1] });
    expect(findLayer([site!], "node-3")!.box).toEqual(yard.box);
  });

  it("finds the layer for a clicked node, or its nearest ancestor that is a layer", () => {
    const tree = layersFromGltf(gltf);
    expect(layerForNode(tree, gltf.nodes, 3)?.name).toBe("Block A");
    // Node 5 has no geometry, so it is not a layer; its parent is.
    expect(layerForNode(tree, gltf.nodes, 5)?.name).toBe("Root");
    expect(layerForNode(tree, gltf.nodes, 99)).toBeUndefined();
  });
});

describe("layers from a tiled model (WP 2.1)", () => {
  it("reads the tree the tiler writes, with ids and boxes as for a single model", () => {
    const extras = { layers: [{ id: "node-2", name: "Building", node: 2, box: { lo: [0, 0, -50], hi: [110, 0, 0] }, children: [{ name: "Walls", node: 0, box: { lo: [0, 0, -50], hi: [50, 0, 0] }, children: [] }, { name: "", node: 1, children: [] }] }] };
    const l = layersFromTileset(extras)!;
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ id: "node-2", name: "Building", node: 2, visible: true, box: { lo: [0, 0, -50], hi: [110, 0, 0] } });
    expect(l[0]!.children.map((c) => [c.id, c.name, !!c.box])).toEqual([["node-0", "Walls", true], ["node-1", "Node 1", false]]);
  });

  it("returns null for a tileset with no parts, or parts it cannot read", () => {
    expect(layersFromTileset(undefined)).toBeNull();
    expect(layersFromTileset({})).toBeNull();
    expect(layersFromTileset({ layers: [] })).toBeNull();
    expect(layersFromTileset({ layers: [{ name: "x", node: "2", children: [] }] })).toBeNull();
    expect(layersFromTileset({ layers: [{ name: "x", node: 2, children: [{ name: "bad" }] }] })).toBeNull();
  });
});

describe("saved layer manifest (WP 2.1)", () => {
  // A building (node 0) with walls (1) and a roof (2, with a chimney 3), and a tree (4).
  const box = (x: number) => ({ lo: [x, 0, 0] as [number, number, number], hi: [x + 1, 1, 1] as [number, number, number] });
  const L = (node: number, name: string, children: Layer[] = []): Layer => ({ id: `node-${node}`, name, node, visible: true, children, box: box(node) });
  const derived = () => [L(0, "Building", [L(1, "Walls"), L(2, "Roof", [L(3, "Chimney")])]), L(4, "Tree")];
  const shape = (ls: Layer[]): unknown[] => ls.map((l) => [l.name, ...(l.children.length ? [shape(l.children)] : [])]);
  /** Every node of the model, exactly once over the whole tree. */
  const everyNodeOnce = (ls: Layer[]) => {
    const seen: number[] = [];
    walk(ls, (l) => seen.push(...layerNodes(l)));
    return seen.sort().join() === "0,1,2,3,4";
  };

  it("leaves the tree as it is with no manifest", () => {
    expect(applyManifest(derived(), null)).toEqual(derived());
    expect(applyManifest(derived(), { layers: [] })).toEqual(derived());
  });

  it("renames and reorders, and keeps the parts it does not mention after its own", () => {
    const t = applyManifest(derived(), { layers: [{ name: "Trees", nodes: [4] }, { name: "Roofs", nodes: [2] }] });
    expect(shape(t)).toEqual([["Trees"], ["Roofs", [["Chimney"]]], ["Building", [["Walls"]]]]);
    expect(t[0]!.id).toBe("node-4");
    expect(everyNodeOnce(t)).toBe(true);
  });

  it("merges several parts into one layer that shows, hides and picks them all", () => {
    const t = applyManifest(derived(), { layers: [{ name: "Structure", nodes: [1, 2] }] });
    expect(shape(t)).toEqual([["Structure"], ["Building"], ["Tree"]]);
    const s = t[0]!;
    expect(layerNodes(s).sort()).toEqual([1, 2, 3]); // the chimney goes with its roof
    expect(s.box).toEqual({ lo: [1, 0, 0], hi: [3, 1, 1] });
    expect(layerForNode(t, [], 3)?.id).toBe(s.id);
    expect(everyNodeOnce(t)).toBe(true);
  });

  it("nests parts under a new group, and takes a part out of its parent", () => {
    const t = applyManifest(derived(), { layers: [{ name: "Site", children: [{ name: "Chimney", nodes: [3] }, { name: "Tree", nodes: [4] }] }] });
    expect(shape(t)).toEqual([["Site", [["Chimney"], ["Tree"]]], ["Building", [["Walls"], ["Roof"]]]]);
    expect(layerNodes(t[0]!)).toEqual([]);
    expect(t[0]!.box).toEqual({ lo: [3, 0, 0], hi: [5, 1, 1] });
    expect(everyNodeOnce(t)).toBe(true);
  });

  it("ignores parts the model does not have, and drops layers left empty", () => {
    const t = applyManifest(derived(), { layers: [{ name: "Gone", nodes: [99] }, { name: "", nodes: [4] }] });
    expect(shape(t)).toEqual([["Tree"], ["Building", [["Walls"], ["Roof", [["Chimney"]]]]]]);
  });

  it("hides a merged layer's parts and its nested layers with it", () => {
    const t = applyManifest(derived(), { layers: [{ name: "All", nodes: [0], children: [{ name: "Tree", nodes: [4] }] }] });
    const v = effectiveVisibility(setVisible(t, "node-0", false));
    expect([...v.values()].every((x) => !x)).toBe(true);
  });
});
