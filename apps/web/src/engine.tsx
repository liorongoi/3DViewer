import { createContext, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ViewerEngine, type Signal } from "@viewer/core";

const EngineContext = createContext<ViewerEngine | null>(null);

export function useEngine(): ViewerEngine | null {
  return useContext(EngineContext);
}

/** Reads a per-frame engine signal without re-rendering the whole tree. */
export function useSignal<T>(s: Signal<T> | undefined, fallback: T): T {
  return useSyncExternalStore(
    (cb) => (s ? s.subscribe(cb) : () => {}),
    () => (s ? s.get() : fallback),
    () => fallback,
  );
}

/** Mounts one full-screen Cesium canvas shared by every UI direction. */
export function EngineProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  const host = useRef<HTMLDivElement>(null);
  const [engine, setEngine] = useState<ViewerEngine | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let e: ViewerEngine | null = null;
    if (!host.current) return;
    ViewerEngine.create(host.current)
      .then((created) => {
        if (disposed) return created.destroy();
        e = created;
        (window as unknown as { viewerEngine: ViewerEngine }).viewerEngine = created;
        setEngine(created);
      })
      .catch((err: unknown) => setFailed(err instanceof Error ? err.message : String(err)));
    return () => {
      disposed = true;
      e?.destroy();
    };
  }, []);

  return (
    <EngineContext.Provider value={engine}>
      <div ref={host} className="fixed inset-0" data-testid="canvas-host" />
      {failed && (
        <div className="fixed inset-0 grid place-items-center">
          <div className="glass rounded-[14px] p-6 max-w-md">
            <div className="font-semibold mb-1">{t("misc.webgl")}</div>
            <div className="text-fg2">{failed}</div>
          </div>
        </div>
      )}
      {children}
    </EngineContext.Provider>
  );
}
