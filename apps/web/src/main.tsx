import "./cesium-base";
import "./styles.css";
import "./i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EngineProvider } from "./engine";
import { App } from "./App";

// "?render-only" shows just the 3D canvas; used by the thumbnail renderer (plan WP 3.5).
const renderOnly = new URLSearchParams(location.search).has("render-only");
// "?test" also exposes Cesium and the samples to the browser tests, with the full UI.
if (renderOnly || new URLSearchParams(location.search).has("test")) {
  void Promise.all([import("cesium"), import("@viewer/shared"), import("./thumbnail")]).then(([Cesium, shared, thumb]) => {
    Object.assign(window, {
      Cesium,
      __samples: shared.SAMPLE_LIBRARY,
      // Called by the server's thumbnail worker and scripts/render-thumbnails.cjs.
      __renderTurntable: (model: never, level: never) =>
        thumb.renderTurntable((window as unknown as { viewerEngine: Parameters<typeof thumb.renderTurntable>[0] }).viewerEngine, model, level),
    });
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EngineProvider>{renderOnly ? null : <App />}</EngineProvider>
  </StrictMode>,
);
