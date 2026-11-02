// Must run before CesiumJS loads: all Cesium assets are served from this app (no CDN).
(window as unknown as { CESIUM_BASE_URL: string }).CESIUM_BASE_URL = new URL("./cesium/", document.baseURI).href;
export {};
