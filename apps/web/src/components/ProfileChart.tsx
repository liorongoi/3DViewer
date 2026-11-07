import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SightPair } from "@viewer/core";

/**
 * Height profile for one line-of-sight pair (VWR-ANL-02).
 * Terrain is the bottom fill, buildings and models the fill above it, and the sight line
 * runs from A to B: solid where it is clear, red after the first obstruction.
 * Hover shows distance, ground, surface and sight-line height at that point.
 */
export function ProfileChart({ pair, height = 150 }: { pair: SightPair; height?: number }) {
  const { t } = useTranslation();
  const W = 288;
  const H = height;
  const pad = { l: 34, r: 8, t: 8, b: 18 };
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const p = pair.profile;

  const geo = useMemo(() => {
    if (p.length < 2) return null;
    const D = pair.distance || 1;
    let lo = Infinity,
      hi = -Infinity;
    for (const s of p) {
      lo = Math.min(lo, s.ground, s.sight);
      hi = Math.max(hi, s.surface, s.sight);
    }
    const span = Math.max(4, hi - lo);
    lo -= span * 0.08;
    hi += span * 0.12;
    const x = (d: number) => pad.l + ((W - pad.l - pad.r) * d) / D;
    const y = (h: number) => pad.t + ((H - pad.t - pad.b) * (hi - h)) / (hi - lo);
    const base = y(lo);
    const area = (key: "ground" | "surface") =>
      `M${x(0)},${base} ` + p.map((s) => `L${x(s.d).toFixed(1)},${y(s[key]).toFixed(1)}`).join(" ") + ` L${x(D)},${base} Z`;
    const ticks = niceTicks(lo, hi, 4);
    return { x, y, D, lo, hi, base, ground: area("ground"), surface: area("surface"), ticks };
  }, [p, pair.distance, H]);

  if (!geo) return <div className="grid h-[120px] place-items-center text-[12px] text-fg3">{pair.computing ? t("profile.sampling") : t("profile.none")}</div>;
  const { x, y, D } = geo;
  const A = p[0]!;
  const B = p[p.length - 1]!;
  const bx = pair.block ? x(pair.block.d) : null;
  const h = hover !== null ? p[hover] : null;

  const onMove = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const d = ((px - pad.l) / (W - pad.l - pad.r)) * D;
    if (d < 0 || d > D) return setHover(null);
    setHover(Math.round((d / D) * (p.length - 1)));
  };

  return (
    <figure className="relative m-0">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full select-none"
        role="img"
        aria-label={t("profile.label", { name: pair.name, length: Math.round(D), state: pair.visible ? t("profile.clear") : t("profile.blockedAt", { d: Math.round(pair.block!.d) }) })}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        {geo.ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
            <text x={pad.l - 4} y={y(t) + 3} textAnchor="end" className="num" fontSize={9} fill="var(--text-tertiary)">
              {Math.round(t)}
            </text>
          </g>
        ))}
        <path d={geo.surface} fill="var(--profile-surface)" />
        <path d={geo.ground} fill="var(--profile-ground)" />
        {bx === null ? (
          <line x1={x(0)} y1={y(A.sight)} x2={x(D)} y2={y(B.sight)} stroke="var(--ok)" strokeWidth={2} />
        ) : (
          <>
            <line x1={x(0)} y1={y(A.sight)} x2={bx} y2={y(pair.block!.sight)} stroke="var(--ok)" strokeWidth={2} />
            <line x1={bx} y1={y(pair.block!.sight)} x2={x(D)} y2={y(B.sight)} stroke="var(--bad)" strokeWidth={2} strokeDasharray="5 3" />
            <circle cx={bx} cy={y(pair.block!.surface)} r={4} fill="var(--bad)" stroke="var(--surface-1-solid)" strokeWidth={2} />
          </>
        )}
        {[
          [A, "A"],
          [B, "B"],
        ].map(([s, l]) => {
          const pt = s as typeof A;
          return (
            <g key={l as string}>
              <line x1={x(pt.d)} x2={x(pt.d)} y1={y(pt.surface)} y2={y(pt.sight)} stroke="var(--text-secondary)" strokeWidth={1} />
              <circle cx={x(pt.d)} cy={y(pt.sight)} r={4} fill="var(--text-primary)" stroke="var(--surface-1-solid)" strokeWidth={2} />
            </g>
          );
        })}
        <text x={pad.l} y={H - 4} fontSize={9} fill="var(--text-tertiary)" className="num">
          0
        </text>
        <text x={W - pad.r} y={H - 4} fontSize={9} fill="var(--text-tertiary)" textAnchor="end" className="num">
          {fmtDist(D)}
        </text>
        <text x={pad.l - 4} y={pad.t - 1} fontSize={9} fill="var(--text-tertiary)" textAnchor="end">
          m
        </text>
        {h && (
          <g pointerEvents="none">
            <line x1={x(h.d)} x2={x(h.d)} y1={pad.t} y2={geo.base} stroke="var(--text-secondary)" strokeWidth={1} strokeDasharray="2 2" />
            <circle cx={x(h.d)} cy={y(h.surface)} r={3} fill="var(--text-primary)" />
          </g>
        )}
      </svg>
      {h && (
        <div
          className="pointer-events-none absolute top-1 rounded-[6px] border border-line bg-s1/95 px-2 py-1 text-[11px] shadow-lg num"
          style={{ [x(h.d) > W / 2 ? "left" : "right"]: 6 }}
          dir="ltr"
        >
          <div className="font-medium text-fg">{t("profile.fromA", { d: fmtDist(h.d) })}</div>
          <div className="text-fg2">{t("profile.ground", { h: h.ground.toFixed(1) })}</div>
          {h.surface - h.ground > 0.5 && <div className="text-fg2">{t("profile.top", { h: h.surface.toFixed(1) })}</div>}
          <div className="text-fg2">
            {t("profile.sight", { h: h.sight.toFixed(1) })} · {h.sight >= h.surface ? t("profile.clearBy", { d: (h.sight - h.surface).toFixed(1) }) : t("profile.blockedBy", { d: (h.surface - h.sight).toFixed(1) })}
          </div>
        </div>
      )}
      <figcaption className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-fg3">
        <span className="inline-flex items-center gap-1">
          <i className="inline-block h-2 w-3 rounded-[2px]" style={{ background: "var(--profile-ground)" }} /> {t("profile.terrain")}
        </span>
        <span className="inline-flex items-center gap-1">
          <i className="inline-block h-2 w-3 rounded-[2px]" style={{ background: "var(--profile-surface)" }} /> {t("profile.buildings")}
        </span>
        <span className="inline-flex items-center gap-1">
          <i className="inline-block h-0.5 w-3" style={{ background: "var(--ok)" }} /> {t("profile.sightLine")}
        </span>
      </figcaption>
    </figure>
  );
}

export function fmtDist(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(m >= 10000 ? 1 : 2)} km` : `${Math.round(m)} m`;
}

function niceTicks(lo: number, hi: number, n: number): number[] {
  const raw = (hi - lo) / n;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((k) => k * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi; t += step) out.push(t);
  return out;
}
