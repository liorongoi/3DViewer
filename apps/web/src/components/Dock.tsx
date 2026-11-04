import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { ViewMode } from "@viewer/core";
import { useEngine, useSignal } from "../engine";
import { useApp } from "../state/store";
import {
  Box,
  Focus,
  HelpCircle,
  House,
  Layers,
  Minus,
  Move,
  Orbit,
  Plane,
  Plus,
  Route,
  Ruler,
  ScissorsLineDashed,
  Settings2,
  Square,
  SquareDashed,
  Sparkles,
  Radar,
  ScanEye,
} from "./icons";
import { Divider, IconButton, cx } from "./primitives";
import { SettingsMenu } from "./SettingsMenu";

const MODE_ICON: Record<ViewMode, typeof Box> = { shaded: Box, edges: Square, wireframe: SquareDashed, unlit: Sparkles };

/** Floating tool dock (SRS 5.1 bottom toolbar). One active tool at a time. */
export function Dock({ className, compact }: { className?: string; compact?: boolean }) {
  const { t } = useTranslation();
  const engine = useEngine();
  const tool = useApp((s) => s.tool);
  const viewMode = useSignal(engine?.viewMode, "shaded");
  const set = useApp((s) => s.set);
  const leftOpen = useApp((s) => s.leftOpen);
  const [menu, setMenu] = useState<"mode" | "settings" | null>(null);
  const [leftDrag, setLeftDrag] = useState<"orbit" | "pan">("orbit");
  const ModeIcon = MODE_ICON[viewMode];

  const setDrag = (m: "orbit" | "pan") => {
    if (engine) engine.camera.leftDrag = m;
    setLeftDrag(m);
    set({ tool: "none" });
  };

  return (
    <div className={cx("relative", className)}>
      <div role="toolbar" aria-label={t("shell.tools")} className="glass flex items-center gap-0.5 rounded-[14px] p-1.5">
        {compact && (
          <>
            <IconButton label={t("viewer.layers")} shortcut="L" active={leftOpen} onClick={() => set({ leftOpen: !leftOpen })}>
              <Layers size={18} />
            </IconButton>
            <Divider vertical />
          </>
        )}
        <IconButton label={t("viewer.home")} shortcut="H" onClick={() => void engine?.home()}>
          <House size={18} />
        </IconButton>
        <IconButton label={t("viewer.focus")} shortcut="Z" onClick={() => void engine?.home(0.8)}>
          <Focus size={18} />
        </IconButton>
        <IconButton label={t("viewer.zoomIn")} shortcut="+" onClick={() => engine?.camera.zoomCentre(2)}>
          <Plus size={18} />
        </IconButton>
        <IconButton label={t("viewer.zoomOut")} shortcut="−" onClick={() => engine?.camera.zoomCentre(-2)}>
          <Minus size={18} />
        </IconButton>
        <Divider vertical />
        <IconButton label={t("viewer.orbit")} shortcut="W" active={tool === "none" && leftDrag === "orbit"} onClick={() => setDrag("orbit")}>
          <Orbit size={18} />
        </IconButton>
        <IconButton label={t("viewer.pan")} shortcut="E" active={tool === "none" && leftDrag === "pan"} onClick={() => setDrag("pan")}>
          <Move size={18} />
        </IconButton>
        <IconButton label={t("shell.flyMode")} shortcut="G" active={tool === "fly"} onClick={() => set({ tool: tool === "fly" ? "none" : "fly" })}>
          <Plane size={18} />
        </IconButton>
        <Divider vertical />
        <IconButton label={t("viewer.viewMode")} shortcut="1–4" active={menu === "mode"} onClick={() => setMenu(menu === "mode" ? null : "mode")}>
          <ModeIcon size={18} />
        </IconButton>
        <Divider vertical />
        <IconButton label={t("viewer.measureDistance")} shortcut="M" active={tool === "distance"} onClick={() => set({ tool: tool === "distance" ? "none" : "distance" })}>
          <Ruler size={18} />
        </IconButton>
        <IconButton label={t("viewer.measurePath")} shortcut="Shift+M" active={tool === "path"} onClick={() => set({ tool: tool === "path" ? "none" : "path" })}>
          <Route size={18} />
        </IconButton>
        <IconButton label={t("shell.lineOfSight")} shortcut="I" active={tool === "sight"} onClick={() => set({ tool: tool === "sight" ? "none" : "sight" })}>
          <ScanEye size={18} />
        </IconButton>
        <IconButton label={t("shell.viewshed")} shortcut="V" active={tool === "viewshed"} onClick={() => set({ tool: tool === "viewshed" ? "none" : "viewshed", rightOpen: true, rightTab: "analysis" })}>
          <Radar size={18} />
        </IconButton>
        <IconButton label={t("viewer.section")} disabled>
          <ScissorsLineDashed size={18} />
        </IconButton>
        <Divider vertical />
        <IconButton label={t("viewer.settings")} active={menu === "settings"} onClick={() => setMenu(menu === "settings" ? null : "settings")}>
          <Settings2 size={18} />
        </IconButton>
        <IconButton label={t("viewer.help")} shortcut="?" onClick={() => set({ helpOpen: true })}>
          <HelpCircle size={18} />
        </IconButton>
      </div>
      {menu === "mode" && (
        <div className="glass absolute bottom-[calc(100%+8px)] start-1/2 -translate-x-1/2 rtl:translate-x-1/2 w-60 rounded-[12px] p-1" role="menu">
          {(["shaded", "edges", "wireframe", "unlit"] as ViewMode[]).map((m, i) => {
            const Icon = MODE_ICON[m];
            return (
              <button
                key={m}
                role="menuitemradio"
                aria-checked={viewMode === m}
                type="button"
                className={cx("flex h-9 w-full items-center gap-2 rounded-[8px] px-2", viewMode === m ? "bg-accent-soft text-accent" : "hover:bg-s3")}
                onClick={() => {
                  engine?.setViewMode(m);
                  setMenu(null);
                }}
              >
                <Icon size={16} />
                <span className="flex-1 text-start">{t(`viewer.modes.${m}`)}</span>
                <span className="num text-[11px] text-fg3">{i + 1}</span>
              </button>
            );
          })}
        </div>
      )}
      {menu === "settings" && <SettingsMenu onClose={() => setMenu(null)} />}
    </div>
  );
}
