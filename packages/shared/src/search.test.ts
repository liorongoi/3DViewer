import { describe, expect, it } from "vitest";
import { containsPhrase, findQuery, matchesQuery, searchKey } from "./search";

describe("search (WP 6.1)", () => {
  it("ignores vowel points and cantillation", () => {
    expect(matchesQuery("שלום", ["שָׁלוֹם עֲלֵיכֶם"])).toBe(true);
    expect(matchesQuery("שָׁלוֹם", ["שלום"])).toBe(true);
    expect(matchesQuery("בראשית", ["בְּרֵאשִׁ֖ית"])).toBe(true);
  });

  it("takes a final letter as its ordinary form, so a word typed part way matches", () => {
    expect(matchesQuery("ירושל", ["מודל ירושלים"])).toBe(true);
    expect(matchesQuery("ירושלים", ["ירושלימ"])).toBe(true);
    for (const [a, b] of [["ך", "כ"], ["ם", "מ"], ["ן", "נ"], ["ף", "פ"], ["ץ", "צ"]]) expect(searchKey(a!)).toBe(searchKey(b!));
  });

  it("matches geresh, gershayim and maqaf with the ASCII marks", () => {
    expect(matchesQuery('צה"ל', ["מבנה צה״ל"])).toBe(true);
    expect(matchesQuery("ג'בל", ["ג׳בל מוכבר"])).toBe(true);
    expect(matchesQuery("בית-לחם", ["בית־לחם"])).toBe(true);
  });

  it("ignores direction marks", () => {
    expect(matchesQuery("גבעה 12", ["גבעה ‏12‎"])).toBe(true);
    expect(matchesQuery("⁧מחנה⁩", ["מחנה צפוני"])).toBe(true);
  });

  it("finds every word in any field, in any order", () => {
    const fields = ["Lyon Fourvière", "פרויקט גשרים", "מבצע אביב"];
    expect(matchesQuery("אביב lyon", fields)).toBe(true);
    expect(matchesQuery("fourviere גשרים", fields)).toBe(true);
    expect(matchesQuery("אביב חורף", fields)).toBe(false);
    expect(matchesQuery("  ", fields)).toBe(true);
  });

  it("is case-blind and keeps undefined fields out", () => {
    expect(matchesQuery("SCIFI", ["SciFi Helmet", undefined, null])).toBe(true);
  });

  it("finds the matched part of the original text for highlighting", () => {
    const text = "בְּסִיס יְרוּשָׁלַיִם";
    const r = findQuery(text, "ירושל")!;
    expect(r).not.toBeNull();
    expect(text.slice(r[0], r[1])).toBe("יְרוּשָׁלַ");
    expect(findQuery("Lyon Fourvière", "fourviere")).toEqual([5, 14]);
    expect(findQuery("abc", "x")).toBeNull();
    expect(findQuery("Block B, floor 2", "block b", true)).toEqual([0, 7]);
    expect(containsPhrase("Block A", "block b")).toBe(false);
    expect(containsPhrase("קוֹמָה ב׳", "קומה ב'")).toBe(true);
  });
});
