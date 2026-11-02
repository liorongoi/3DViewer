import { describe, expect, it } from "vitest";
import { en, he } from "./i18n";

function keys(o: object, prefix = ""): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === "string" ? [`${prefix}${k}`] : keys(v as object, `${prefix}${k}.`),
  );
}

describe("i18n", () => {
  it("Hebrew and English have the same keys", () => {
    expect(keys(he).sort()).toEqual(keys(en).sort());
  });
  it("no empty strings", () => {
    for (const k of keys(he)) expect(k.length).toBeGreaterThan(0);
  });
});
