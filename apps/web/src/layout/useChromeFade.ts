import { useEffect, useState } from "react";
import { useApp } from "../state/store";

/**
 * UI direction A + C: the floating tools step back so the view gets the whole screen.
 * - idle: no pointer or key for 2.5 s. Dock, view cube, scale and buttons fade out;
 *   open panels stay.
 * - navigating: dragging or scrolling the 3D view. Everything, open panels included,
 *   fades to a faint ghost and comes back 400 ms after the camera stops.
 * Any pointer move or key brings the tools back at once.
 */
export function useChromeFade(): { idle: boolean; navigating: boolean } {
  const enabled = useApp((s) => s.fadeTools);
  const tool = useApp((s) => s.tool);
  const [idle, setIdle] = useState(false);
  const [navigating, setNavigating] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setIdle(false);
      setNavigating(false);
      return;
    }
    let idleTimer: ReturnType<typeof setTimeout>;
    let navTimer: ReturnType<typeof setTimeout>;
    let down = false;
    const onCanvas = (e: Event) => (e.target as Element | null)?.tagName === "CANVAS";
    const wake = () => {
      setIdle(false);
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => setIdle(true), 2500);
    };
    const settle = (ms: number) => {
      clearTimeout(navTimer);
      navTimer = setTimeout(() => setNavigating(false), ms);
    };
    const onDown = (e: PointerEvent) => {
      wake();
      down = onCanvas(e);
    };
    const onMove = (e: PointerEvent) => {
      wake();
      if (down && e.buttons !== 0) {
        clearTimeout(navTimer);
        setNavigating(true);
      }
    };
    const onUp = () => {
      down = false;
      settle(400);
    };
    const onWheel = (e: WheelEvent) => {
      wake();
      if (!onCanvas(e)) return;
      setNavigating(true);
      settle(400);
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("pointerup", onUp, true);
    window.addEventListener("pointercancel", onUp, true);
    window.addEventListener("wheel", onWheel, { capture: true, passive: true });
    window.addEventListener("keydown", wake, true);
    wake();
    return () => {
      clearTimeout(idleTimer);
      clearTimeout(navTimer);
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("pointerup", onUp, true);
      window.removeEventListener("pointercancel", onUp, true);
      window.removeEventListener("wheel", onWheel, true);
      window.removeEventListener("keydown", wake, true);
    };
  }, [enabled]);

  // While a tool waits for clicks on the map, the user needs to see what it is doing.
  const busy = tool !== "none" && tool !== "fly";
  return { idle: enabled && idle && !busy, navigating: enabled && navigating && !busy };
}

/** Classes for ambient tools (dock, cube, scale) and for open panels. */
export function fadeClasses({ idle, navigating }: { idle: boolean; navigating: boolean }) {
  const base = "transition-opacity duration-300 motion-reduce:transition-none";
  return {
    ambient: `${base} ${idle || navigating ? "opacity-0 pointer-events-none [&_*]:pointer-events-none" : "opacity-100"}`,
    panel: `${base} ${navigating ? "opacity-15 [&_*]:pointer-events-none" : "opacity-100"}`,
  };
}
