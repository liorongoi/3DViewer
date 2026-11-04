import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * WP 1.8 / NFR-17: every text colour in the design tokens reaches WCAG AA (4.5:1) on every
 * surface it is drawn on, in both themes. Read from tokens.css itself, so a token change that
 * breaks contrast fails here.
 */

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");

function theme(name: "dark" | "light"): Record<string, string> {
  const block = new RegExp(`:root\\[data-theme="${name}"\\][^{]*\\{([^}]*)\\}`).exec(css)?.[1];
  if (!block) throw new Error(`No ${name} theme in tokens.css`);
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1]!, m[2]!.trim()]));
}

type Rgba = [number, number, number, number];
function parse(c: string): Rgba {
  const hex = /^#([0-9a-f]{6})$/i.exec(c);
  if (hex) return [0, 2, 4].map((i) => parseInt(hex[1]!.slice(i, i + 2), 16)).concat(1) as Rgba;
  const rgb = /^rgb\((\d+) (\d+) (\d+)(?: \/ ([\d.]+))?\)$/.exec(c);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] ? Number(rgb[4]) : 1];
  throw new Error(`Cannot read colour ${c}`);
}
/** A translucent colour laid over an opaque one. */
const over = (top: Rgba, under: Rgba): Rgba => [0, 1, 2].map((i) => top[i]! * top[3] + under[i]! * (1 - top[3])).concat(1) as Rgba;
const luminance = ([r, g, b]: Rgba) =>
  [r, g, b].map((v) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)).reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
export function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

/** Text tokens, and the surfaces text sits on. */
const TEXT = ["text-primary", "text-secondary", "text-tertiary", "accent", "status-draft", "status-production", "status-current", "status-superseded", "ok", "bad", "danger"];
const SURFACES = ["surface-1-solid", "surface-2", "surface-3", "glass", "glass+accent-soft", "glass+highlight"];

for (const name of ["dark", "light"] as const) {
  describe(`${name} theme`, () => {
    const t = theme(name);
    const canvas = parse(t["canvas-bg"]!);
    // The glass panels over the globe: surface-1 over the canvas colour, and over black and white,
    // the darkest and lightest a map can be under them.
    const glass = over(parse(t["surface-1"]!), canvas);
    const surface = (s: string): Rgba[] => {
      if (s === "glass") return [glass, over(parse(t["surface-1"]!), [0, 0, 0, 1]), over(parse(t["surface-1"]!), [255, 255, 255, 1])];
      if (s === "glass+accent-soft") return [over(parse(t["accent-soft"]!), glass)];
      if (s === "glass+highlight") return [over(parse(t["highlight"]!), glass)];
      return [parse(t[s]!)];
    };

    for (const fg of TEXT)
      it(`${fg} reaches 4.5:1 on every surface`, () => {
        const worst = Math.min(...SURFACES.flatMap((s) => surface(s).map((bg) => contrast(parse(t[fg]!), bg))));
        expect(worst, `${fg} ${t[fg]}`).toBeGreaterThanOrEqual(4.5);
      });

    it("text on the accent colour reaches 4.5:1", () => {
      expect(contrast(parse(t["accent-on"]!), parse(t["accent"]!))).toBeGreaterThanOrEqual(4.5);
    });

    it("control borders reach 3:1 against the panel (WCAG 1.4.11)", () => {
      // Inputs and secondary buttons draw their outline in control-border; inputs are filled surface-2.
      expect(Math.min(...[...surface("glass"), parse(t["surface-2"]!)].map((bg) => contrast(parse(t["control-border"]!), bg)))).toBeGreaterThanOrEqual(3);
    });
  });
}
