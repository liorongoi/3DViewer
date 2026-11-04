import { useLibrary } from "../state/library";
import { Command } from "cmdk";
import { useTranslation } from "react-i18next";
import { parseCoordinateQuery, walk } from "@viewer/core";
import { useState } from "react";
import { useEngine, useSignal } from "../engine";
import { useApp } from "../state/store";
import { Box, Crosshair, Eye, House, Layers, Moon, Orbit, Plane, Route, Ruler, Search, Upload, ScanEye, Radar, Map } from "./icons";

/** Ctrl+K: every command, layer and model, plus "fly to coordinates" (UI spec 1.1 #6). */
export function CommandPalette({ onOpenModel }: { onOpenModel: (id: string) => void }) {
  const { t } = useTranslation();
  const library = useLibrary();
  const engine = useEngine();
  const open = useApp((s) => s.paletteOpen);
  const set = useApp((s) => s.set);
  const layers = useSignal(engine?.layers, []);
  const [q, setQ] = useState("");
  if (!open) return null;
  const close = () => {
    set({ paletteOpen: false });
    setQ("");
  };
  const run = (fn: () => void) => () => {
    fn();
    close();
  };
  const coords = parseCoordinateQuery(q);
  const flatLayers: { id: string; name: string }[] = [];
  walk(layers, (l) => flatLayers.push({ id: l.id, name: l.name }));
  const item = "flex h-9 cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 text-fg2 data-[selected=true]:bg-s3 data-[selected=true]:text-fg";
  const group = "px-1 pb-1 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:uppercase [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:text-fg3";

  return (
    <div className="fixed inset-0 z-50 grid items-start justify-center bg-black/30 pt-[14vh]" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <Command label={t("shell.palette")} className="glass w-[640px] max-w-[92vw] overflow-hidden rounded-[14px]" shouldFilter loop onKeyDown={(e) => e.key === "Escape" && close()}>
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search size={16} className="text-fg3" />
          <Command.Input autoFocus value={q} onValueChange={setQ} placeholder={t("palette.placeholder")} className="h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-fg3" />
        </div>
        <Command.List label={t("palette.results")} className="max-h-[50vh] overflow-auto p-1 scrollbar-thin">
          <Command.Empty className="p-4 text-fg3">{t("palette.nothing")}</Command.Empty>
          {coords && (
            <Command.Group heading={t("palette.goToHeading")} className={group}>
              <Command.Item value={`goto ${q}`} className={item} onSelect={run(() => engine?.flyTo(coords.lat, coords.lon))}>
                <Crosshair size={16} className="text-accent" />
                <span dir="ltr" className="num">{t("palette.goTo", { coords: `${coords.lat.toFixed(5)}, ${coords.lon.toFixed(5)}` })}</span>
              </Command.Item>
            </Command.Group>
          )}
          <Command.Group heading={t("palette.commands")} className={group}>
            <Command.Item className={item} onSelect={run(() => void engine?.home())}><House size={16} />{t("viewer.home")}<Shortcut k="H" /></Command.Item>
            <Command.Item className={item} onSelect={run(() => set({ tool: "distance" }))}><Ruler size={16} />{t("viewer.measureDistance")}<Shortcut k="M" /></Command.Item>
            <Command.Item className={item} onSelect={run(() => set({ tool: "path" }))}><Route size={16} />{t("viewer.measurePath")}<Shortcut k="⇧M" /></Command.Item>
            <Command.Item className={item} onSelect={run(() => set({ tool: "sight" }))}><ScanEye size={16} />{t("shell.lineOfSightPoints")}<Shortcut k="I" /></Command.Item>
            <Command.Item className={item} onSelect={run(() => set({ tool: "viewshed" }))}><Radar size={16} />{t("shell.viewshedPoint")}<Shortcut k="V" /></Command.Item>
            <Command.Item className={item} onSelect={run(() => set({ leftOpen: true, leftTab: "map" }))}><Map size={16} />{t("shell.mapPanel")}</Command.Item>
            <Command.Item className={item} onSelect={run(() => set({ tool: "fly" }))}><Plane size={16} />{t("shell.flyMode")}<Shortcut k="G" /></Command.Item>
            <Command.Item className={item} onSelect={run(() => engine?.startOrbitTour())}><Orbit size={16} />{t("shell.flyBy")}</Command.Item>
            {(["shaded", "edges", "wireframe", "unlit"] as const).map((m, i) => (
              <Command.Item key={m} className={item} onSelect={run(() => engine?.setViewMode(m))}><Box size={16} />{t(`viewer.modes.${m}`)}<Shortcut k={String(i + 1)} /></Command.Item>
            ))}
            <Command.Item className={item} onSelect={run(() => set({ leftOpen: true }))}><Layers size={16} />{t("viewer.layers")}<Shortcut k="L" /></Command.Item>
            <Command.Item className={item} onSelect={run(() => set({ uploadOpen: true }))}><Upload size={16} />{t("library.upload")}</Command.Item>
            <Command.Item
              className={item}
              onSelect={run(() => {
                const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
                document.documentElement.dataset.theme = next;
                useApp.getState().setPref("theme", next);
              })}
            >
              <Moon size={16} />{t("settings.theme")}
            </Command.Item>
          </Command.Group>
          {flatLayers.length > 0 && (
            <Command.Group heading={t("palette.layers")} className={group}>
              {flatLayers.slice(0, 200).map((l) => (
                <Command.Item key={l.id} value={`layer ${l.name} ${l.id}`} className={item} onSelect={run(() => void engine?.focusLayer(l.id))}>
                  <Eye size={16} /><span data-content>{l.name}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          <Command.Group heading={t("palette.models")} className={group}>
            {library.map((m) => (
              <Command.Item key={m.id} value={`model ${m.name} ${m.project} ${m.operation}`} className={item} onSelect={run(() => onOpenModel(m.id))}>
                <Box size={16} />
                <span className="flex-1 truncate" dir="auto" data-content>{m.name}</span>
                <span className="text-[12px] text-fg3" data-content>{m.project}</span>
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}

function Shortcut({ k }: { k: string }) {
  return <span className="num ms-auto text-[11px] text-fg3">{k}</span>;
}
