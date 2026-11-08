import { describe, expect, it } from "vitest";
import { en, he } from "./i18n";

function keys(o: object, prefix = ""): string[] {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === "string" ? [`${prefix}${k}`] : keys(v as object, `${prefix}${k}.`),
  );
}

describe("i18n", () => {
  // Plural forms follow each language's rules: Hebrew has a form for two that English lacks.
  const plural = /_(zero|one|two|few|many|other)$/;
  const base = (ks: string[]) => [...new Set(ks.map((k) => k.replace(plural, "_*")))].sort();
  it("Hebrew and English have the same keys", () => {
    expect(base(keys(he))).toEqual(base(keys(en)));
  });
  it("every plural has each form the language uses, or i18next shows the key itself", () => {
    for (const [lang, table] of [["en", en], ["he", he]] as const) {
      const ks = new Set(keys(table));
      const forms = new Intl.PluralRules(lang).resolvedOptions().pluralCategories;
      for (const k of base([...ks]).filter((k) => k.endsWith("_*")))
        for (const f of forms) expect(ks.has(k.replace("_*", `_${f}`)), `${lang}: ${k.replace("_*", `_${f}`)}`).toBe(true);
    }
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
