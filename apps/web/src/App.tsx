import { SAMPLE_LIBRARY } from "@viewer/shared";
import { useEngine, useSignal } from "./engine";
import { useApp } from "./state/store";
import { useAppEffects, useOpenModel } from "./useAppEffects";
import { ClassificationBanner } from "./components/ClassificationBanner";
import { CommandPalette } from "./components/CommandPalette";
import { HelpOverlay } from "./components/HelpOverlay";
import { UploadWizard } from "./components/UploadWizard";
import { useFilteredModels } from "./components/Library";
import { UNCLASSIFIED, useClassOf } from "./state/classification";
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
  const level = route === "viewer" && current ? classOf(current) : UNCLASSIFIED;
  void visible;

  return (
    <>
      <ClassificationBanner level={level} position="top" />
      <ClassificationBanner level={level} position="bottom" />
      <Workspace />
      <CommandPalette onOpenModel={open} />
      <HelpOverlay />
      <UploadWizard />
      <noscript>{SAMPLE_LIBRARY.length}</noscript>
    </>
  );
}
