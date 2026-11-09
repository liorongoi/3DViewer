import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { addGroup, mergeLayers, moveLayer, nestLayer, renameLayer, shiftLayer, toManifest, walkEdit, type EditLayer } from "@viewer/core";
import { useEngine } from "../engine";
import { useApp } from "../state/store";
import { putLayerManifest } from "../server/api";
import { STANDARD_LAYERS, standardGroups } from "../layers-standard";
import { ArrowDown, ArrowUp, FolderPlus, GripVertical, IndentDecrease, IndentIncrease, Merge, Wand2, X } from "./icons";
import { IconButton, cx } from "./primitives";
import { useDialog } from "./useDialog";
import { errorText } from "../server/error-text";

type Drop = { key: string; where: "before" | "after" | "inside" };

/**
 * The producer's layer editor (WP 4.3, UPL-09): rename, merge, nest and reorder the open model's
 * layers, by dragging or with the buttons on each row, with the standard names suggested. Saved
 * for everyone on the model's current version, which is the one open (earlier versions keep
 * theirs); the next version starts from it.
 */
export function LayerEditor({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const server = useApp((s) => s.server);
  const model = engine?.current.get() ?? null;
  const start = useMemo(() => engine?.editableLayers() ?? [], [engine]);
  const [tree, setTree] = useState<EditLayer[]>(start);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState<string | null>(null);
  const [drop, setDrop] = useState<Drop | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const box = useDialog<HTMLDivElement>(true, { onClose: () => !saving && onClose() });
  const standard = STANDARD_LAYERS.map((s) => t(`layerEditor.standard.${s}`));
  const changed = JSON.stringify(toManifest(tree)) !== JSON.stringify(toManifest(start));

  // A new group's name is ready to type over.
  useEffect(() => {
    if (!focusKey) return;
    const el = box.current?.querySelector<HTMLInputElement>(`[data-edit="${CSS.escape(focusKey)}"] > div input[list]`);
    el?.focus();
    el?.select();
    setFocusKey(null);
  }, [focusKey, tree]);

  if (!engine || !model || !server) return null;

  const save = async (reset: boolean) => {
    setSaving(true);
    setProblem(null);
    const manifest = reset ? null : toManifest(tree);
    try {
      await putLayerManifest(server, model.id, manifest);
      if (engine.current.get() === model) engine.setLayerManifest(manifest);
      onClose();
    } catch (e) {
      setProblem(t("layerEditor.saveFailed", { reason: errorText(e, t) }));
    } finally {
      setSaving(false);
    }
  };

  const parts = (l: EditLayer) => {
    let n = l.nodes.length;
    walkEdit(l.children, (c) => (n += c.nodes.length));
    return n;
  };

  const row = (l: EditLayer, depth: number, siblings: EditLayer[], i: number): ReactNode => {
    const at = drop?.key === l.key ? drop.where : null;
    return (
      <li key={l.key} data-edit={l.key} role="treeitem" aria-label={l.name} aria-level={depth + 1} aria-selected={picked.has(l.key)}>
        <div
          className={cx(
            "group flex h-9 items-center gap-1 rounded-[6px] pe-1",
            picked.has(l.key) ? "bg-accent-soft" : "hover:bg-s3",
            at === "inside" && "outline outline-2 outline-accent",
            drag === l.key && "opacity-40",
          )}
          style={{ paddingInlineStart: 4 + depth * 18, boxShadow: at === "before" ? "inset 0 2px 0 var(--accent)" : at === "after" ? "inset 0 -2px 0 var(--accent)" : undefined }}
          onDragOver={(e) => {
            if (!drag || drag === l.key) return;
            e.preventDefault();
            const r = e.currentTarget.getBoundingClientRect();
            const y = (e.clientY - r.top) / r.height;
            setDrop({ key: l.key, where: y < 0.28 ? "before" : y > 0.72 ? "after" : "inside" });
          }}
          onDragLeave={() => setDrop((d) => (d?.key === l.key ? null : d))}
          onDrop={(e) => {
            e.preventDefault();
            if (drag && drop) setTree(moveLayer(tree, drag, drop.key, drop.where));
            setDrag(null);
            setDrop(null);
          }}
        >
          <span
            draggable
            data-grip
            onDragStart={(e) => {
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", l.name);
              setDrag(l.key);
            }}
            onDragEnd={() => (setDrag(null), setDrop(null))}
            className="grid h-7 w-5 cursor-grab place-items-center text-fg3"
            aria-hidden
          >
            <GripVertical size={14} />
          </span>
          <input
            type="checkbox"
            className="accent-[var(--accent)]"
            checked={picked.has(l.key)}
            aria-label={t("layerEditor.select", { name: l.name })}
            onChange={() =>
              setPicked((p) => {
                const n = new Set(p);
                if (n.has(l.key)) n.delete(l.key);
                else n.add(l.key);
                return n;
              })
            }
          />
          <input
            className="input h-7 min-w-0 flex-1 px-1.5"
            dir="auto"
            value={l.name}
            list="layer-standard-names"
            aria-label={t("layerEditor.name")}
            maxLength={200}
            onChange={(e) => setTree(renameLayer(tree, l.key, e.target.value))}
          />
          <span className="num w-14 shrink-0 text-end text-[11px] text-fg3">{l.nodes.length || l.children.length ? t("layerEditor.parts", { count: parts(l) }) : t("layerEditor.empty")}</span>
          <IconButton size="sm" label={t("layerEditor.up")} disabled={i === 0} onClick={() => setTree(shiftLayer(tree, l.key, -1))}>
            <ArrowUp size={14} />
          </IconButton>
          <IconButton size="sm" label={t("layerEditor.down")} disabled={i === siblings.length - 1} onClick={() => setTree(shiftLayer(tree, l.key, 1))}>
            <ArrowDown size={14} />
          </IconButton>
          <IconButton size="sm" label={t("layerEditor.nest")} disabled={i === 0} onClick={() => setTree(nestLayer(tree, l.key, false))}>
            <IndentIncrease size={14} className="rtl:-scale-x-100" />
          </IconButton>
          <IconButton size="sm" label={t("layerEditor.unnest")} disabled={depth === 0} onClick={() => setTree(nestLayer(tree, l.key, true))}>
            <IndentDecrease size={14} className="rtl:-scale-x-100" />
          </IconButton>
        </div>
        {l.children.length > 0 && <ul role="group">{l.children.map((c, j) => row(c, depth + 1, l.children, j))}</ul>}
      </li>
    );
  };

  const button = "inline-flex h-8 items-center gap-1.5 rounded-[8px] bg-s2 px-2.5 text-[12px] font-medium hover:bg-s3 disabled:opacity-40";
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/40" onPointerDown={(e) => e.target === e.currentTarget && !saving && onClose()}>
      <div
        ref={box}
        role="dialog"
        aria-modal="true"
        aria-label={t("layerEditor.title")}
        data-testid="layer-editor"
        className="glass flex max-h-[86vh] w-[640px] max-w-[94vw] flex-col rounded-[14px]"
      >
        <header className="flex items-start gap-3 border-b border-line p-4 pb-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold">{t("layerEditor.title")}</h2>
            <p className="text-fg3">{t("upload.layersHint")} {t("layerEditor.dragHint")}</p>
          </div>
          <IconButton size="sm" label={t("common.close")} onClick={onClose}>
            <X size={15} />
          </IconButton>
        </header>
        <div className="flex flex-wrap gap-1.5 px-4 pt-3">
          <button
            type="button"
            className={button}
            onClick={() => {
              const g = addGroup(tree, t("layerEditor.newGroupName"));
              setTree(g.tree);
              setFocusKey(g.key);
            }}
          >
            <FolderPlus size={14} /> {t("layerEditor.newGroup")}
          </button>
          <button
            type="button"
            className={button}
            disabled={picked.size < 2}
            onClick={() => {
              setTree(mergeLayers(tree, [...picked]));
              setPicked(new Set());
            }}
          >
            <Merge size={14} /> {t("layerEditor.merge", { count: picked.size })}
          </button>
          <button type="button" className={button} onClick={() => setTree(standardGroups(tree, t))}>
            <Wand2 size={14} /> {t("upload.applySuggestions")}
          </button>
        </div>
        <datalist id="layer-standard-names">
          {standard.map((s) => <option key={s} value={s} />)}
        </datalist>
        <div className="min-h-0 flex-1 overflow-auto p-3 scrollbar-thin">
          {tree.length ? <ul role="tree" aria-label={t("layerEditor.title")}>{tree.map((l, i) => row(l, 0, tree, i))}</ul> : <p className="p-3 text-fg3">{t("viewer.noLayers")}</p>}
        </div>
        {problem && <p role="alert" className="px-4 pb-2 text-[12px] text-danger">{problem}</p>}
        <footer className="flex items-center gap-2 border-t border-line p-3">
          <button type="button" className="h-8 rounded-[8px] px-3 text-fg2 hover:bg-s3 hover:text-fg disabled:opacity-40" disabled={saving} onClick={() => void save(true)}>
            {t("layerEditor.reset")}
          </button>
          <span className="flex-1 text-[12px] text-fg3">{t("layerEditor.forEveryone", { v: model.version })}</span>
          <button type="button" onClick={onClose} disabled={saving} className="h-8 rounded-[8px] px-3 text-fg2 hover:bg-s3 hover:text-fg">
            {t("common.cancel")}
          </button>
          <button type="button" disabled={saving || !changed} onClick={() => void save(false)} className="h-8 rounded-[8px] bg-accent px-3 font-medium text-accent-on disabled:opacity-50">
            {saving ? t("props.saving") : t("props.save")}
          </button>
        </footer>
      </div>
    </div>
  );
}
