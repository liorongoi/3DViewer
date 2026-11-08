import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { effectiveVisibility, filterLayers, isolate, setAllVisible, setVisible, type Layer } from "@viewer/core";
import { useEngine, useSignal } from "../engine";
import { ChevronRight, Eye, EyeOff, Focus, Layers, ListTree, Scan, Search, X } from "./icons";
import { LayerEditor } from "./LayerEditor";
import { IconButton, Panel, cx } from "./primitives";
import { MapTab } from "./MapTab";
import { useApp } from "../state/store";
import { pushUndo } from "../state/undo";

/** Layers panel (LYR-01..05): tree, eye toggles, search, show/hide all, isolate, Alt+click solo, drag-paint. */
export function LayersPanel({ onClose, className }: { onClose?: () => void; className?: string }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const layers = useSignal(engine?.layers, []);
  const selected = useSignal(engine?.selectedLayer, null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [beforeIsolate, setBeforeIsolate] = useState<Layer[] | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const paint = useRef<boolean | null>(null);
  const leftTab = useApp((s) => s.leftTab);
  const setApp = useApp((s) => s.set);

  const model = useSignal(engine?.current, null);
  const server = useApp((s) => s.server);
  const [editing, setEditing] = useState(false);
  // Only the library's models are arranged, for everyone, on their current version.
  const arrangeable = !!server && !!model && !model.id.startsWith("upload-") && layers.length > 0;
  const older = !!model && model.version < model.versions;

  const vis = useMemo(() => effectiveVisibility(layers), [layers]);
  const shown = useMemo(() => filterLayers(layers, query), [layers, query]);

  const apply = (next: Layer[]) => engine?.setLayers(next);
  const toggle = (l: Layer, value = !l.visible) => apply(setVisible(engine!.layers.get(), l.id, value));
  const solo = (l: Layer) => {
    const before = beforeIsolate ?? layers;
    setBeforeIsolate(before);
    apply(isolate(layers, l.id));
    pushUndo(t("viewer.isolated", { name: l.name }), () => {
      apply(before);
      setBeforeIsolate(null);
    });
  };
  const hideAll = () => {
    const before = layers;
    apply(setAllVisible(layers, false));
    pushUndo(t("viewer.allHidden"), () => apply(before));
  };

  // A part clicked in the 3D view: open its branch and bring its row into view.
  useEffect(() => {
    if (!selected) return;
    const trail: string[] = [];
    const find = (ls: Layer[], path: string[]): boolean =>
      ls.some((l) => (l.id === selected ? (trail.push(...path), true) : find(l.children, [...path, l.id])));
    find(layers, []);
    setCollapsed((c) => (trail.some((id) => c.has(id)) ? new Set([...c].filter((id) => !trail.includes(id))) : c));
    requestAnimationFrame(() => list.current?.querySelector(`[data-layer="${CSS.escape(selected)}"]`)?.scrollIntoView({ block: "nearest" }));
  }, [selected, layers]);

  const row = (l: Layer, depth: number) => {
    const effective = vis.get(l.id) ?? true;
    const open = !collapsed.has(l.id) || !!query;
    return (
      <li key={l.id} role="treeitem" aria-expanded={l.children.length ? open : undefined} aria-selected={l.id === selected} data-layer={l.id}>
        <div
          className={cx("group flex h-8 items-center gap-1 rounded-[6px] pe-1 hover:bg-s3", l.id === selected && "bg-accent-soft")}
          style={{ paddingInlineStart: 4 + depth * 14 }}
          onPointerEnter={() => {
            if (paint.current !== null && l.visible !== paint.current) toggle(l, paint.current);
            engine?.highlightLayer(l.id);
          }}
          onPointerLeave={() => engine?.highlightLayer(null)}
        >
          <button
            type="button"
            aria-label={open ? t("shell.collapse") : t("shell.expand")}
            className={cx("grid h-6 w-5 place-items-center text-fg3", !l.children.length && "invisible")}
            onClick={() =>
              setCollapsed((c) => {
                const n = new Set(c);
                if (n.has(l.id)) n.delete(l.id);
                else n.add(l.id);
                return n;
              })
            }
          >
            <ChevronRight size={14} className={cx("transition-transform rtl:-scale-x-100", open && "rotate-90 rtl:rotate-90")} />
          </button>
          <button
            type="button"
            aria-label={l.visible ? t("common.hide") : t("common.show")}
            title={`${l.visible ? t("common.hide") : t("common.show")} · ${t("shell.altClick")}: ${t("viewer.isolate")}`}
            disabled={l.node === undefined && !l.nodes?.length && !l.nodeName && l.id !== "tileset" && !l.children.length}
            className={cx("grid h-7 w-7 place-items-center rounded", l.visible ? "text-fg2 hover:text-fg" : "text-fg3", "disabled:opacity-30")}
            onPointerDown={(e) => {
              if (e.altKey) return;
              paint.current = !l.visible;
              toggle(l, !l.visible);
              const up = () => {
                paint.current = null;
                window.removeEventListener("pointerup", up);
              };
              window.addEventListener("pointerup", up);
            }}
            onClick={(e) => {
              if (e.altKey) solo(l);
            }}
          >
            {l.visible ? <Eye size={15} /> : <EyeOff size={15} />}
          </button>
          <span
            className={cx("min-w-0 flex-1 cursor-default truncate", effective ? "text-fg" : "text-fg3")}
            dir="auto"
            data-content
            onClick={() => engine?.selectedLayer.set(l.id === selected ? null : l.id)}
            onDoubleClick={() => (engine?.selectedLayer.set(l.id), void engine?.focusLayer(l.id))}
          >
            <Highlight text={l.name} query={query} />
          </span>
          <span className="flex opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            <IconButton size="sm" label={t("viewer.isolate")} onClick={() => solo(l)}>
              <Scan size={14} />
            </IconButton>
            <IconButton size="sm" label={t("viewer.focus")} onClick={() => (engine?.selectedLayer.set(l.id), void engine?.focusLayer(l.id))}>
              <Focus size={14} />
            </IconButton>
          </span>
        </div>
        {l.children.length > 0 && open && (
          <ul role="group">{l.children.map((c) => row(c, depth + 1))}</ul>
        )}
      </li>
    );
  };

  return (
    <Panel className={cx("w-[300px] max-h-full", className)}>
      <header className="flex h-11 shrink-0 items-center gap-2 ps-3 pe-1.5 border-b border-line">
        <Layers size={16} className="text-fg2" />
        <div role="tablist" className="flex flex-1 gap-0.5">
          {(
            [
              ["model", t("viewer.layers")],
              ["map", t("shell.mapData")],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              role="tab"
              type="button"
              aria-selected={leftTab === id}
              onClick={() => setApp({ leftTab: id })}
              className={cx("h-8 rounded-[6px] px-2.5 text-[13px] font-medium", leftTab === id ? "bg-s3 text-fg" : "text-fg3 hover:text-fg")}
            >
              {label}
            </button>
          ))}
        </div>
        {onClose && (
          <IconButton size="sm" label={t("common.close")} shortcut="L" onClick={onClose}>
            <X size={15} />
          </IconButton>
        )}
      </header>
      {leftTab === "map" ? (
        <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
          <MapTab />
        </div>
      ) : (
      <>
      <div className="flex flex-col gap-2 p-2 border-b border-line">
        <label className="flex h-8 items-center gap-2 rounded-[6px] bg-s2 px-2 border border-line focus-within:border-accent">
          <Search size={14} className="text-fg3" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("viewer.searchLayers")}
            aria-label={t("viewer.searchLayers")}
            className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-fg3"
          />
        </label>
        <div className="flex gap-1">
          <button type="button" className="h-7 flex-1 rounded-[6px] bg-s2 text-[12px] font-medium hover:bg-s3" onClick={() => apply(setAllVisible(layers, true))}>
            {t("viewer.showAll")}
          </button>
          <button type="button" className="h-7 flex-1 rounded-[6px] bg-s2 text-[12px] font-medium hover:bg-s3" onClick={hideAll}>
            {t("viewer.hideAll")}
          </button>
          {arrangeable && (
            <IconButton size="sm" label={older ? t("layerEditor.onlyCurrent") : t("layerEditor.open")} disabled={older} onClick={() => setEditing(true)}>
              <ListTree size={15} />
            </IconButton>
          )}
          {beforeIsolate && (
            <button
              type="button"
              className="h-7 flex-1 rounded-[6px] bg-accent-soft text-accent text-[12px] font-medium"
              onClick={() => {
                apply(beforeIsolate);
                setBeforeIsolate(null);
              }}
            >
              {t("viewer.undoIsolate")}
            </button>
          )}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-1 scrollbar-thin">
        {shown.length ? (
          <ul ref={list} role="tree" aria-label={t("viewer.layers")}>{shown.map((l) => row(l, 0))}</ul>
        ) : (
          <p className="p-3 text-fg3">{t("viewer.noLayers")}</p>
        )}
      </div>
      </>
      )}
      {editing && createPortal(<LayerEditor onClose={() => setEditing(false)} />, document.body)}
    </Panel>
  );
}

/** The name with the part that matches the search marked. */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLocaleLowerCase();
  const at = q ? text.toLocaleLowerCase().indexOf(q) : -1;
  if (at < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, at)}
      <mark className="rounded-[3px] bg-accent-soft text-fg">{text.slice(at, at + q.length)}</mark>
      {text.slice(at + q.length)}
    </>
  );
}
