import type { ModelSummary } from "@viewer/shared";
import { desktop, desktopInfo } from "../desktop";
import { useApp } from "./store";

/** A model opened in place from this computer (the desktop app's viewer-file:// URLs). */
const fromThisComputer = (m: ModelSummary) => m.source.url.startsWith("viewer-file:");

/**
 * The Windows app's own library: the models opened from this computer stay listed after a
 * restart (the main process keeps them, with the folders they were opened from), and leave it
 * when deleted. Also reads how the app is set up: the sample library (checks only) and online maps.
 */
export async function startDesktopLibrary(): Promise<void> {
  if (!desktop) return;
  const info = await desktopInfo();
  useApp.setState({
    samples: !!info?.samples,
    onlineMaps: { on: !!info?.onlineMaps, locked: !!info?.onlineMapsLocked },
  });
  if (!desktop.loadLibrary || !desktop.saveLibrary) return;
  const kept = await desktop.loadLibrary().catch(() => null);
  if (kept) {
    const models = kept.models as ModelSummary[];
    useApp.setState((s) => ({
      // Anything opened while loading comes first; a kept model is not listed twice.
      uploads: [...s.uploads, ...models.filter((m) => !s.uploads.some((u) => u.id === m.id))],
      uploadFiles: { ...kept.files, ...s.uploadFiles },
      missingModels: kept.missing,
    }));
  }
  // From now on every change is kept (only after loading, so an empty start never wipes the list).
  let last = "";
  const save = () => {
    const s = useApp.getState();
    const models = s.uploads.filter(fromThisComputer);
    const files = Object.fromEntries(models.map((m) => [m.id, s.uploadFiles[m.id] ?? []]));
    const text = JSON.stringify([models, files]);
    if (text === last) return;
    last = text;
    void desktop!.saveLibrary!(models, files);
  };
  save();
  useApp.subscribe((s, prev) => {
    if (s.uploads !== prev.uploads || s.uploadFiles !== prev.uploadFiles) save();
  });
}

/** The user's switch for online maps in the desktop app; IT's decision wins. */
export async function setOnlineMaps(on: boolean): Promise<void> {
  const cur = useApp.getState().onlineMaps;
  if (!desktop?.setOnlineMaps || !cur || cur.locked) return;
  const now = await desktop.setOnlineMaps(on);
  useApp.setState({ onlineMaps: { on: now, locked: false } });
}
