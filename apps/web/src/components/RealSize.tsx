import { useTranslation } from "react-i18next";
import { Ruler, Wand2, Move3d } from "./icons";
import { cx } from "./primitives";

/**
 * "How big is it?" for a model with no coordinates (docs/GAUSSIAN_SPLATS.md, scaling).
 * One real measurement is enough to scale a model evenly: the operator picks which side they know
 * (as wide, as deep or as tall as the model stands) and types its length in metres. A model whose
 * size nobody knows stays floating: drawn in its own units, measured in model units, exported unscaled.
 */
export type SizeMode = "units" | "known" | "floating";
export type KnownSide = "w" | "d" | "h";

export interface SizeChoice {
  mode: SizeMode;
  side: KnownSide;
  metres: string;
}

/** The model's extent as it stands: width (east–west), depth (north–south), height, in file units. */
export function standingSize(size: [number, number, number], upAxis: "y" | "z"): Record<KnownSide, number> {
  const [w, d, h] = upAxis === "z" ? [size[0], size[1], size[2]] : [size[0], size[2], size[1]];
  return { w, d, h };
}

/** The scale that makes the chosen side the given length; null until that is a usable number. */
export function scaleFromKnown(size: [number, number, number] | undefined, upAxis: "y" | "z", c: SizeChoice): number | null {
  if (!size || c.mode !== "known") return null;
  const m = parseFloat(c.metres.replace(",", "."));
  const along = standingSize(size, upAxis)[c.side];
  if (!(m > 0) || !(along > 0) || !Number.isFinite(m / along)) return null;
  return m / along;
}

const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(2));

export function RealSize({
  size,
  upAxis,
  value,
  onChange,
  splats,
  children,
}: {
  size?: [number, number, number];
  upAxis: "y" | "z";
  value: SizeChoice;
  onChange: (c: SizeChoice) => void;
  /** Splat models come from training: their units are almost never metres. */
  splats: boolean;
  /** The units picker, shown under "Its units are right". */
  children?: React.ReactNode;
}) {
  const { t } = useTranslation();
  const k = scaleFromKnown(size, upAxis, value);
  const sides = size ? standingSize(size, upAxis) : null;
  const options: { mode: SizeMode; icon: typeof Ruler; title: string; hint: string }[] = [
    ...(splats ? [] : [{ mode: "units" as const, icon: Move3d, title: t("splat.size.unitsTitle"), hint: t("splat.size.unitsHint") }]),
    { mode: "known", icon: Ruler, title: t("splat.size.knownTitle"), hint: t("splat.size.knownHint") },
    { mode: "floating", icon: Wand2, title: t("splat.size.floatingTitle"), hint: t("splat.size.floatingHint") },
  ];
  return (
    <fieldset className="grid gap-2" data-testid="real-size">
      <legend className="mb-1 text-[13px] font-semibold">{t("splat.size.question")}</legend>
      <div className={cx("grid gap-2", options.length === 3 ? "sm:grid-cols-3" : "sm:grid-cols-2")} role="radiogroup">
        {options.map((o) => (
          <button
            key={o.mode}
            type="button"
            role="radio"
            aria-checked={value.mode === o.mode}
            data-testid={`size-${o.mode}`}
            onClick={() => onChange({ ...value, mode: o.mode })}
            className={cx(
              "flex flex-col items-start gap-1 rounded-[12px] border p-3 text-start transition-colors",
              value.mode === o.mode ? "border-accent bg-accent-soft" : "border-line-strong hover:border-accent/60 hover:bg-s2",
            )}
          >
            <o.icon size={18} className={value.mode === o.mode ? "text-accent" : "text-fg3"} />
            <span className="text-[13px] font-medium text-fg">{o.title}</span>
            <span className="text-[12px] text-fg3">{o.hint}</span>
          </button>
        ))}
      </div>
      {value.mode === "units" && children}
      {value.mode === "known" && (
        <div className="grid gap-2 rounded-[12px] bg-s2 p-3">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-fg3">{t("splat.size.side")}</span>
              <select className="input" value={value.side} data-testid="known-side" onChange={(e) => onChange({ ...value, side: e.target.value as KnownSide })}>
                {(["w", "d", "h"] as const).map((s) => (
                  <option key={s} value={s}>
                    {t(`splat.size.side_${s}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-[12px] text-fg3">{t("splat.size.realLength")}</span>
              <span className="flex items-center gap-1">
                <input className="input num w-28" inputMode="decimal" dir="ltr" value={value.metres} data-testid="known-metres" placeholder="12.5" onChange={(e) => onChange({ ...value, metres: e.target.value })} />
                <span className="text-fg3">m</span>
              </span>
            </label>
          </div>
          {sides && (
            <p className="text-[12px] text-fg3">
              {t("splat.size.nowUnits", { n: fmt(sides[value.side]) })}
            </p>
          )}
          {k ? (
            <p className="text-[12px] text-[var(--status-current)]" data-testid="known-result">
              {t("splat.size.result", { w: fmt(sides!.w * k), d: fmt(sides!.d * k), h: fmt(sides!.h * k) })}
            </p>
          ) : (
            <p className="text-[12px] text-fg3">{t("splat.size.emptyIsFloating")}</p>
          )}
        </div>
      )}
      {value.mode === "floating" && <p className="rounded-[12px] bg-s2 p-3 text-[12px] text-fg2">{t("splat.size.floatingMore")}</p>}
    </fieldset>
  );
}
