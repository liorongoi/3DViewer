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

describe("english()", () => {
  it("fills values and picks the plural by count", async () => {
    const { english, hasEnglish } = await import("./i18n");
    expect(english("checks.missingRefs.title", { count: 1 })).toBe("1 referenced file is missing");
    expect(english("checks.missingRefs.title", { count: 3 })).toBe("3 referenced files are missing");
    expect(english("checks.unreadable.title", { file: "a.glb" })).toBe("a.glb cannot be read");
    expect(english("no.such.key")).toBe("no.such.key");
    expect(hasEnglish("checks.badViews.detail")).toBe(true);
    expect(hasEnglish("checks.extensions.detail")).toBe(false);
  });
});
