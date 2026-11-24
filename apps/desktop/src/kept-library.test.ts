import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { keptDirs, readKept, referencedRoots, toKept, writeKept } from "./kept-library";
import { Roots } from "./local-files";

const tmp: string[] = [];
const dir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "kept-"));
  tmp.push(d);
  return d;
};
afterEach(() => tmp.splice(0).forEach((d) => fs.rmSync(d, { recursive: true, force: true })));

const model = (id: string, url: string) => ({ id, name: id, source: { kind: "glb", url } });

describe("kept library", () => {
  it("finds the folders a list refers to", () => {
    expect([...referencedRoots('{"u":"viewer-file://abc123/x.glb","v":"viewer-file://zz99/a/b","w":"https://x/"}')]).toEqual(["abc123", "zz99"]);
  });

  it("keeps models across a restart: the same URLs open the same files", () => {
    const home = dir();
    const data = dir();
    fs.writeFileSync(path.join(home, "bottle.glb"), "glb!");
    fs.writeFileSync(path.join(home, "secret.txt"), "no");
    const before = new Roots();
    const id = before.add(home, undefined, ["bottle.glb"]);
    const url = `viewer-file://${id}/bottle.glb`;
    const kept = toKept(before, [model("upload-1", url)], { "upload-1": [url, "https://evil/"] });
    expect(kept?.roots[id]).toEqual({ dir: fs.realpathSync(home), only: ["bottle.glb"] });
    expect(kept?.files["upload-1"]).toEqual([url]);
    const file = path.join(data, "library.json");
    writeKept(file, kept!);

    const after = new Roots();
    const r = readKept(file, after);
    expect(r.models).toHaveLength(1);
    expect(r.missing).toEqual([]);
    expect(after.resolve(id, "bottle.glb")).toBe(path.join(fs.realpathSync(home), "bottle.glb"));
    // Still only what was opened, not the rest of the folder.
    expect(after.resolve(id, "secret.txt")).toBeNull();
    expect(keptDirs(file)).toEqual(new Set([fs.realpathSync(home)]));
  });

  it("never keeps a folder the user did not open this session", () => {
    const roots = new Roots();
    const kept = toKept(roots, [model("upload-1", "viewer-file://made1up/x.glb")], {});
    expect(kept?.roots).toEqual({});
    const file = path.join(dir(), "library.json");
    writeKept(file, kept!);
    const r = readKept(file, new Roots());
    expect(r.missing).toEqual(["upload-1"]);
  });

  it("lists a model whose folder is gone as missing, so it can be deleted", () => {
    const home = dir();
    fs.writeFileSync(path.join(home, "a.glb"), "x");
    const roots = new Roots();
    const id = roots.add(home, undefined, ["a.glb"]);
    const file = path.join(dir(), "library.json");
    writeKept(file, toKept(roots, [model("upload-a", `viewer-file://${id}/a.glb`)], {})!);
    fs.rmSync(home, { recursive: true, force: true });
    const r = readKept(file, new Roots());
    expect(r.models).toHaveLength(1);
    expect(r.missing).toEqual(["upload-a"]);
  });

  it("refuses what is not a list, and starts empty from a broken file", () => {
    expect(toKept(new Roots(), "nope", {})).toBeNull();
    const file = path.join(dir(), "library.json");
    fs.writeFileSync(file, "{broken");
    expect(readKept(file, new Roots())).toEqual({ models: [], files: {}, missing: [] });
  });

  it("does not take a kept id that is already in use or malformed", () => {
    const a = dir();
    const roots = new Roots();
    expect(roots.restore("../x", a)).toBe(false);
    expect(roots.restore("abcd1234", a)).toBe(true);
    expect(roots.restore("abcd1234", dir())).toBe(false);
  });
});
