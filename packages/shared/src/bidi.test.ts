import { describe, expect, it } from "vitest";
import { isolateValue, stripBidi } from "./bidi";

describe("isolateValue (WP 6.1)", () => {
  it("isolates text and numbers in Hebrew only", () => {
    expect(isolateValue("-33.5", "he")).toBe("⁨-33.5⁩");
    expect(isolateValue(12, "he")).toBe("⁨12⁩");
    expect(isolateValue("-33.5", "en")).toBe("-33.5");
  });
  it("leaves empty values, objects and already isolated values as they are", () => {
    expect(isolateValue("", "he")).toBe("");
    const o = { a: 1 };
    expect(isolateValue(o, "he")).toBe(o);
    expect(isolateValue("⁨x⁩", "he")).toBe("⁨x⁩");
  });
  it("strips direction marks", () => {
    expect(stripBidi("⁨v3⁩ מתוך ⁨4⁩")).toBe("v3 מתוך 4");
  });
});
