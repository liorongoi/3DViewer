import "./cesium-base";
import "./styles.css";
import "./i18n";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { EngineProvider } from "./engine";
import { App } from "./App";

// "?render-only" shows just the 3D canvas; used by the thumbnail renderer (plan WP 3.5).
const renderOnly = new URLSearchParams(location.search).has("render-only");
if (renderOnly) {
  void Promise.all([import("cesium"), import("@viewer/shared")]).then(([Cesium, shared]) => {
    Object.assign(window, { Cesium, __samples: shared.SAMPLE_LIBRARY });
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <EngineProvider>{renderOnly ? null : <App />}</EngineProvider>
  </StrictMode>,
);
