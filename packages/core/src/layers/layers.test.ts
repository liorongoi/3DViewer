import { describe, expect, it } from "vitest";
import { effectiveVisibility, filterLayers, findLayer, isolate, layerForNode, layersFromGltf, setAllVisible, setVisible } from "./layers";

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
