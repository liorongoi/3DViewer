import { SAMPLE_LIBRARY } from "@viewer/shared";
import { useEngine, useSignal } from "./engine";
import { useApp } from "./state/store";
import { useAppEffects, useOpenModel } from "./useAppEffects";
import { ClassificationBanner } from "./components/ClassificationBanner";
import { CommandPalette } from "./components/CommandPalette";
import { HelpOverlay } from "./components/HelpOverlay";
import { UploadWizard } from "./components/UploadWizard";
import { AdminPanel } from "./components/AdminPanel";
import { useFilteredModels } from "./components/Library";
import { useClassOf, useLowestLevel } from "./state/classification";
import { Workspace } from "./layout/Workspace";

export function App() {
  useAppEffects();
  const engine = useEngine();
  const route = useApp((s) => s.route);
  const current = useSignal(engine?.current, null);
  const visible = useFilteredModels();
  const { open } = useOpenModel();

  // The globe, terrain and base map alone are unclassified; an open model raises the
  // banner to its own classification, as the user set it (UPL-10).
  const classOf = useClassOf();
  const lowest = useLowestLevel();
  const level = route === "viewer" && current ? classOf(current) : lowest;
  void visible;

  return (
    <>
      <ClassificationBanner level={level} position="top" />
      <ClassificationBanner level={level} position="bottom" />
      <Workspace />
      <CommandPalette onOpenModel={open} />
      <HelpOverlay />
      <UploadWizard />
      <AdminPanel />
      <noscript>{SAMPLE_LIBRARY.length}</noscript>
    </>
  );
}
