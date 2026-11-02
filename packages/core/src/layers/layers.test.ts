import { describe, expect, it } from "vitest";
import { effectiveVisibility, filterLayers, isolate, layersFromGltf, setAllVisible, setVisible } from "./layers";

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
