import { create } from "zustand";
import { useApp } from "./store";

/** One step that Ctrl+Z can take back (UI spec 5.2: isolate, hide all and delete measurement). */
export interface UndoStep {
  id: number;
  /** What was done, in the interface language: shown beside the Undo button. */
  label: string;
  /** The model it was done on: a step never reaches into another model. */
  modelId: string | null;
  run: () => void;
}

const LIMIT = 20;
let seq = 0;

export const useUndo = create<{ steps: UndoStep[] }>(() => ({ steps: [] }));

export function pushUndo(label: string, run: () => void): void {
  const step = { id: ++seq, label, modelId: useApp.getState().modelId, run };
  useUndo.setState((s) => ({ steps: [...s.steps.slice(-(LIMIT - 1)), step] }));
}

/** Takes back the last step on the open model. False when there is none. */
export function undo(): boolean {
  const modelId = useApp.getState().modelId;
  const steps = useUndo.getState().steps.filter((s) => s.modelId === modelId);
  const last = steps[steps.length - 1];
  useUndo.setState({ steps: steps.slice(0, -1) });
  if (!last) return false;
  last.run();
  return true;
}
