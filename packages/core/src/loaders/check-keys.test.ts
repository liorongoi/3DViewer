import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hasEnglish } from "@viewer/shared";

// Every checkItem(…, "key") in the model checks and the server has its text in English and Hebrew
// (the i18n test checks that Hebrew has the same keys).
describe("check report keys", () => {
  it("are all in the strings", () => {
    const roots = [path.join(__dirname), path.join(__dirname, "../../../../apps/server/src")];
    const keys = new Set<string>();
    for (const dir of roots)
      for (const f of readdirSync(dir).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts")))
        for (const m of readFileSync(path.join(dir, f), "utf8").matchAll(/checkItem\(\s*"[a-z]+",\s*"[a-z]+",\s*(?:[^,]*\?\s*)?"(\w+)"(?:\s*:\s*"(\w+)")?/g))
          for (const k of [m[1], m[2]]) if (k) keys.add(k);
    expect(keys.size).toBeGreaterThan(40);
    const missing = [...keys].filter((k) => !hasEnglish(`checks.${k}.title`));
    expect(missing).toEqual([]);
  });
});
