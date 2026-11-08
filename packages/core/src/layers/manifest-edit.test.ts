import { describe, expect, it } from "vitest";
import type { LayerManifest } from "@viewer/shared";
import { applyManifest, layerNodes, walk, type Layer } from "./layers";
import { addGroup, editableTree, findEdit, groupByStandard, mergeLayers, moveLayer, nestLayer, renameLayer, shiftLayer, toManifest, walkEdit, type EditLayer } from "./manifest-edit";

// A building (node 0) with walls (1) and a roof (2, with a chimney 3), and a tree (4).
const L = (node: number, name: string, children: Layer[] = []): Layer => ({ id: `node-${node}`, name, node, visible: true, children });
const derived = () => [L(0, "Building", [L(1, "Walls"), L(2, "Roof", [L(3, "Chimney")])]), L(4, "Tree")];
const shape = (ls: { name: string; children: unknown[] }[]): unknown[] => ls.map((l) => [l.name, ...(l.children.length ? [shape(l.children as typeof ls)] : [])]);
/** What everyone sees: names, nesting and which parts each layer switches. */
const seen = (ls: Layer[]): unknown[] => ls.map((l) => [l.name, layerNodes(l).sort(), ...(l.children.length ? [seen(l.children)] : [])]);
const byName = (t: EditLayer[], name: string) => {
  let f: EditLayer | undefined;
  walkEdit(t, (l) => (l.name === name && !f ? (f = l) : undefined));
  return f!.key;
};
/** Saved and shown again: the viewer shows what the editor showed. */
const roundTrip = (t: EditLayer[]) => applyManifest(derived(), toManifest(t));
const everyNodeOnce = (ls: Layer[]) => {
  const all: number[] = [];
  walk(ls, (l) => all.push(...layerNodes(l)));
  return all.sort().join() === "0,1,2,3,4";
};

describe("layer editor (WP 4.3)", () => {
  it("starts from the file's own tree when nothing was saved", () => {
    const t = editableTree(derived(), null);
    expect(shape(t)).toEqual([["Building", [["Walls"], ["Roof", [["Chimney"]]]]], ["Tree"]]);
    expect(seen(roundTrip(t))).toEqual(seen(derived()));
  });

  it("starts from a saved arrangement, and saving it unchanged changes nothing", () => {
    const manifests: LayerManifest[] = [
      { layers: [{ name: "Trees", nodes: [4] }, { name: "Roofs", nodes: [2] }] },
      { layers: [{ name: "Structure", nodes: [1, 2] }] },
      { layers: [{ name: "Site", children: [{ name: "Chimney", nodes: [3] }, { name: "Tree", nodes: [4] }] }] },
      { layers: [{ name: "Ghost", nodes: [99] }, { name: "Tree", nodes: [4] }] },
    ];
    for (const m of manifests) {
      const t = editableTree(derived(), m);
      expect(seen(roundTrip(t))).toEqual(seen(applyManifest(derived(), m)));
      // And again: a second save of what was loaded is the same.
      expect(seen(applyManifest(derived(), toManifest(editableTree(derived(), toManifest(t)))))).toEqual(seen(applyManifest(derived(), m)));
    }
  });

  it("renames", () => {
    const t = editableTree(derived(), null);
    const r = renameLayer(t, byName(t, "Tree"), "Olive tree");
    expect(shape(r)[1]).toEqual(["Olive tree"]);
    expect(seen(roundTrip(r))[1]).toEqual(["Olive tree", [4]]);
  });

  it("reorders by drag (before, after) and by one step", () => {
    const t = editableTree(derived(), null);
    const tree = byName(t, "Tree");
    const building = byName(t, "Building");
    expect(shape(moveLayer(t, tree, building, "before")).map((x) => (x as string[])[0])).toEqual(["Tree", "Building"]);
    expect(shape(shiftLayer(t, tree, -1)).map((x) => (x as string[])[0])).toEqual(["Tree", "Building"]);
    expect(shiftLayer(t, building, -1)).toBe(t); // already first
    const walls = byName(t, "Walls");
    const roof = byName(t, "Roof");
    expect(shape(shiftLayer(t, walls, 1))[0]).toEqual(["Building", [["Roof", [["Chimney"]]], ["Walls"]]]);
    expect(shape(moveLayer(t, walls, roof, "after"))[0]).toEqual(["Building", [["Roof", [["Chimney"]]], ["Walls"]]]);
    expect(everyNodeOnce(roundTrip(moveLayer(t, tree, building, "before")))).toBe(true);
  });

  it("nests by drag and in or out by one step, and never into its own child", () => {
    const t = editableTree(derived(), null);
    const tree = byName(t, "Tree");
    const chimney = byName(t, "Chimney");
    const building = byName(t, "Building");
    const roof = byName(t, "Roof");
    const inRoof = moveLayer(t, tree, roof, "inside");
    expect(shape(inRoof)).toEqual([["Building", [["Walls"], ["Roof", [["Chimney"], ["Tree"]]]]]]);
    expect(seen(roundTrip(inRoof))).toEqual([["Building", [0], [["Walls", [1]], ["Roof", [2], [["Chimney", [3]], ["Tree", [4]]]]]]]);
    // Out of the roof and the building: after its parent each time.
    const out1 = nestLayer(t, chimney, true);
    expect(shape(out1)[0]).toEqual(["Building", [["Walls"], ["Roof"], ["Chimney"]]]);
    expect(shape(nestLayer(out1, chimney, true)).map((x) => (x as string[])[0])).toEqual(["Building", "Chimney", "Tree"]);
    expect(nestLayer(t, building, true)).toBe(t); // already at the top
    // In: into the sibling above.
    expect(shape(nestLayer(t, tree, false))).toEqual([["Building", [["Walls"], ["Roof", [["Chimney"]]], ["Tree"]]]]);
    expect(nestLayer(t, building, false)).toBe(t); // nothing above it
    // A layer cannot go inside itself or its own parts.
    expect(moveLayer(t, building, roof, "inside")).toBe(t);
    expect(moveLayer(t, building, building, "after")).toBe(t);
    const saved = roundTrip(nestLayer(out1, chimney, true));
    expect(everyNodeOnce(saved)).toBe(true);
    expect(seen(saved)).toEqual([["Building", [0], [["Walls", [1]], ["Roof", [2]]]], ["Chimney", [3]], ["Tree", [4]]]);
  });

  it("merges parts into one layer that switches them all, in the first one's place", () => {
    const t = editableTree(derived(), null);
    const m = mergeLayers(t, [byName(t, "Tree"), byName(t, "Walls")]);
    expect(shape(m)).toEqual([["Building", [["Walls"], ["Roof", [["Chimney"]]]]]]);
    const shown = roundTrip(m);
    expect(seen(shown)).toEqual([["Building", [0], [["Walls", [1, 4]], ["Roof", [2], [["Chimney", [3]]]]]]]);
    expect(everyNodeOnce(shown)).toBe(true);
    // A layer and one of its own parts: the part goes with it, nothing to merge.
    expect(mergeLayers(t, [byName(t, "Roof"), byName(t, "Chimney")])).toBe(t);
    expect(mergeLayers(t, [byName(t, "Roof")])).toBe(t);
  });

  it("adds a group to gather layers in; an empty one is not saved", () => {
    const t = editableTree(derived(), null);
    const { tree: g, key } = addGroup(t, "Site");
    expect(toManifest(g).layers.map((l) => l.name)).toEqual(["Building", "Tree"]);
    const filled = moveLayer(g, byName(g, "Tree"), key, "inside");
    expect(seen(roundTrip(filled))).toEqual([["Site", [], [["Tree", [4]]]], ["Building", [0], [["Walls", [1]], ["Roof", [2], [["Chimney", [3]]]]]]]);
    expect(findEdit(filled, key)?.children).toHaveLength(1);
  });

  it("gathers the top-level layers under the standard names, in the list's order", () => {
    const standard = ["Terrain", "Buildings", "Infrastructure", "Vegetation", "Water", "Other"] as const;
    const suggest = (n: string) => (/build|wall|roof/i.test(n) ? "Buildings" : /tree/i.test(n) ? "Vegetation" : "Other");
    const t = editableTree([L(4, "Tree"), L(0, "Building", [L(1, "Walls")]), L(2, "Roof"), L(3, "Lamp")], null);
    const g = groupByStandard(t, suggest, standard);
    expect(shape(g)).toEqual([["Buildings", [["Building", [["Walls"]]], ["Roof"]]], ["Vegetation", [["Tree"]]], ["Other", [["Lamp"]]]]);
    // A layer already named after a standard group is that group.
    const named = renameLayer(t, byName(t, "Roof"), "Buildings");
    expect(shape(groupByStandard(named, suggest, standard))).toEqual([["Buildings", [["Building", [["Walls"]]]]], ["Vegetation", [["Tree"]]], ["Other", [["Lamp"]]]]);
    expect(groupByStandard(named, suggest, standard)[0]!.nodes).toEqual([2]);
    // All under one root: the groups go inside it.
    const rooted = editableTree([L(9, "Scene", [L(4, "Tree"), L(0, "Building"), L(3, "Lamp")])], null);
    expect(shape(groupByStandard(rooted, suggest, standard))).toEqual([["Scene", [["Buildings", [["Building"]]], ["Vegetation", [["Tree"]]], ["Other", [["Lamp"]]]]]]);
  });

  it("saves names trimmed, and an empty name as Layer", () => {
    const t = editableTree(derived(), null);
    const m = toManifest(renameLayer(renameLayer(t, byName(t, "Tree"), "  Olive  "), byName(t, "Walls"), "   "));
    expect(m.layers[1]).toEqual({ name: "Olive", nodes: [4] });
    expect(m.layers[0]!.children![0]).toEqual({ name: "Layer", nodes: [1] });
  });
});
