import { useMemo, useState } from "react";
import { useClassOf, useLevels } from "../state/classification";
import { useLibrary } from "../state/library";
import { useTranslation } from "react-i18next";
import { UPDATE_STATUSES, type ModelSummary } from "@viewer/shared";
import { useApp, type Filters } from "../state/store";
import { Box, Boxes, ChevronDown, FileBox, Search, X } from "./icons";
import { StatusBadge, cx } from "./primitives";

export function filterModels(models: ModelSummary[], f: Filters, classOf: (m: ModelSummary) => string = (m) => m.classificationId): ModelSummary[] {
  const q = f.query.trim().toLocaleLowerCase();
  return models.filter(
    (m) =>
      (!q || [m.name, m.project, m.operation, m.responsibleEntity, m.description].some((s) => s.toLocaleLowerCase().includes(q))) &&
      (!f.project || m.project === f.project) &&
      (!f.operation || m.operation === f.operation) &&
      (!f.status || m.status === f.status) &&
      (!f.entity || m.responsibleEntity === f.entity) &&
      (!f.classification || classOf(m) === f.classification),
  );
}

export function useFilteredModels(): ModelSummary[] {
  const filters = useApp((s) => s.filters);
  const overrides = useApp((s) => s.classOverrides);
  const all = useLibrary();
  return useMemo(() => filterModels(all, filters, (m) => overrides[m.id] ?? m.classificationId), [all, filters, overrides]);
}

export function SearchField({ className, autoFocus }: { className?: string; autoFocus?: boolean }) {
  const { t } = useTranslation();
  const query = useApp((s) => s.filters.query);
  const setFilters = useApp((s) => s.setFilters);
  return (
    <label className={cx("flex h-10 items-center gap-2 rounded-[10px] bg-s2 px-3 border border-line focus-within:border-accent", className)}>
      <Search size={16} className="text-fg3" />
      <input
        autoFocus={autoFocus}
        value={query}
        onChange={(e) => setFilters({ query: e.target.value })}
        placeholder={t("library.searchPlaceholder")}
        aria-label={t("common.search")}
        className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-fg3"
      />
      {query && (
        <button type="button" aria-label="Clear" onClick={() => setFilters({ query: "" })} className="text-fg3 hover:text-fg">
          <X size={14} />
        </button>
      )}
    </label>
  );
}

export function FilterChips({ className }: { className?: string }) {
  const levels = useLevels();
  const { t } = useTranslation();
  const f = useApp((s) => s.filters);
  const setFilters = useApp((s) => s.setFilters);
  const all = useLibrary();
  const uniq = (k: keyof ModelSummary) => [...new Set(all.map((m) => String(m[k])))].sort();
  const chips: { key: keyof Filters; label: string; options: { value: string; label: string }[] }[] = [
    { key: "project", label: t("library.filters.project"), options: uniq("project").map((v) => ({ value: v, label: v })) },
    { key: "operation", label: t("library.filters.operation"), options: uniq("operation").map((v) => ({ value: v, label: v })) },
    { key: "status", label: t("library.filters.status"), options: UPDATE_STATUSES.map((s) => ({ value: s, label: t(`status.${s}`) })) },
    { key: "entity", label: t("library.filters.entity"), options: uniq("responsibleEntity").map((v) => ({ value: v, label: v })) },
    { key: "classification", label: t("library.filters.classification"), options: levels.map((c) => ({ value: c.id, label: c.label })) },
  ];
  const any = chips.some((c) => f[c.key]);
  return (
    <div className={cx("flex flex-wrap items-center gap-1.5", className)}>
      {chips.map((c) => (
        <FilterChip key={c.key} label={c.label} value={f[c.key] as string | null} options={c.options} onChange={(v) => setFilters({ [c.key]: v } as Partial<Filters>)} />
      ))}
      {any && (
        <button
          type="button"
          className="h-7 px-2 text-[12px] text-fg3 hover:text-fg"
          onClick={() => setFilters({ project: null, operation: null, status: null, entity: null, classification: null })}
        >
          {t("library.clearFilters")}
        </button>
      )}
    </div>
  );
}

function FilterChip({ label, value, options, onChange }: { label: string; value: string | null; options: { value: string; label: string }[]; onChange: (v: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const current = options.find((o) => o.value === value);
  return (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className={cx(
          "inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[12px] font-medium",
          value ? "border-accent text-accent bg-accent-soft" : "border-line-strong text-fg2 hover:text-fg",
        )}
      >
        {current ? `${label}: ${current.label}` : label}
        {value ? (
          <X
            size={12}
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
            }}
          />
        ) : (
          <ChevronDown size={12} />
        )}
      </button>
      {open && (
        <ul role="listbox" className="glass absolute top-[calc(100%+4px)] start-0 z-30 min-w-48 rounded-[10px] p-1" onMouseLeave={() => setOpen(false)}>
          {options.map((o) => (
            <li key={o.value}>
              <button
                type="button"
                role="option"
                aria-selected={o.value === value}
                className={cx("flex h-8 w-full items-center rounded-[6px] px-2 text-start text-[12px]", o.value === value ? "bg-accent-soft text-accent" : "hover:bg-s3")}
                onClick={() => {
                  onChange(o.value);
                  setOpen(false);
                }}
              >
                {o.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const FORMAT_LABEL: Record<string, string> = { glb: "GLB", gltf: "glTF", fbx: "FBX", "3dtiles": "3D Tiles" };

export function ModelCard({ m, onOpen, dense }: { m: ModelSummary; onOpen: () => void; dense?: boolean }) {
  const { t } = useTranslation();
  const cls = useClassOf()(m);
  const [thumbOk, setThumbOk] = useState(true);
  const [frame, setFrame] = useState<number | null>(null);
  // The server's turntable when it has one; the bundled samples otherwise.
  const thumb = m.thumbnail ?? `samples/thumbs/${m.id}.webp`;
  const Icon = m.sourceFormat === "3dtiles" ? Boxes : m.sourceFormat === "fbx" ? FileBox : Box;
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cx(
        "group relative flex w-full flex-col overflow-hidden rounded-[10px] border border-line bg-s2 text-start transition-[transform,border-color] duration-150 hover:-translate-y-0.5 hover:border-line-strong",
        dense && "flex-row",
      )}
      onPointerMove={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        setFrame(Math.floor(((e.clientX - r.left) / r.width) * 24) % 24);
      }}
      onPointerLeave={() => setFrame(null)}
    >
      {cls && <span aria-label={cls.label} data-content className="absolute inset-x-0 top-0 z-10 h-1.5" style={{ background: cls.color }} />}
      <div className={cx("relative overflow-hidden bg-[radial-gradient(120%_90%_at_50%_30%,#2a2e36,#121417)]", dense ? "h-20 w-28 shrink-0" : "aspect-[16/9] w-full")}>
        {thumbOk ? (
          <div
            role="img"
            data-content
            aria-label={m.name}
            className="absolute inset-0 bg-no-repeat"
            style={{
              backgroundImage: `url("${thumb}")`,
              backgroundSize: "2400% 100%",
              backgroundPosition: `${((frame ?? 0) / 23) * 100}% 0`,
            }}
          >
            <img src={thumb} alt="" className="hidden" onError={() => setThumbOk(false)} />
          </div>
        ) : (
          <div className="absolute inset-0 grid place-items-center text-fg3">
            <Icon size={36} strokeWidth={1.25} />
          </div>
        )}
        <span className="absolute bottom-1.5 end-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] font-semibold text-white/90">{FORMAT_LABEL[m.sourceFormat]}</span>
        {cls && !dense && (
          <span className="absolute top-2.5 start-2 rounded px-1.5 py-0.5 text-[9px] font-semibold tracking-wider" style={{ background: cls.color, color: cls.textColor }}>
            {cls.label.split(" ")[0]}
          </span>
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 p-3">
        <div className="line-clamp-2 font-semibold leading-5 text-fg" dir="auto" data-content>{m.name}</div>
        <div className="truncate text-[12px] text-fg3" data-content>
          {m.project} · {m.operation}
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <StatusBadge status={m.status} compact />
          <span className="num truncate text-[11px] text-fg3">
            {t("library.version", { version: m.version })} · {m.statusChangedAt}
          </span>
        </div>
      </div>
    </button>
  );
}

export function LibraryGrid({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation();
  const models = useFilteredModels();
  if (!models.length) return <p className="p-8 text-center text-fg3">{t("library.empty")}</p>;
  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
      {models.map((m) => (
        <ModelCard key={m.id} m={m} onOpen={() => onOpen(m.id)} />
      ))}
    </div>
  );
}
