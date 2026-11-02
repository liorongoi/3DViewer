import { SAMPLE_CLASSIFICATIONS, SAMPLE_LIBRARY } from "@viewer/shared";
import { useEngine, useSignal } from "./engine";
import { useApp } from "./state/store";
import { useAppEffects, useOpenModel } from "./useAppEffects";
import { ClassificationBanner } from "./components/ClassificationBanner";
import { CommandPalette } from "./components/CommandPalette";
import { HelpOverlay } from "./components/HelpOverlay";
import { UploadWizard } from "./components/UploadWizard";
import { useFilteredModels } from "./components/Library";
import { Workspace } from "./layout/Workspace";

export function App() {
  useAppEffects();
  const engine = useEngine();
  const route = useApp((s) => s.route);
  const current = useSignal(engine?.current, null);
  const visible = useFilteredModels();
  const { open } = useOpenModel();

  // The banner shows the highest classification on screen (UPL-10).
  const ids = route === "viewer" && current ? [current.classificationId] : visible.map((m) => m.classificationId);
  const level =
    SAMPLE_CLASSIFICATIONS.filter((c) => ids.includes(c.id)).sort((a, b) => b.order - a.order)[0] ?? SAMPLE_CLASSIFICATIONS[0]!;

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
