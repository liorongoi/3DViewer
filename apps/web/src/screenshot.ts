import type { ViewerEngine } from "@viewer/core";
import type { ClassificationLevel, ModelSummary } from "@viewer/shared";

/**
 * Screenshot with the classification banner burned into the pixels, top and bottom,
 * plus a caption with the model, version, place and time (UPL-10, WP 4.5).
 * The banner is part of the image, so a crop of the middle still shows the caption line.
 */
export async function screenshotWithBanner(engine: ViewerEngine, level: ClassificationLevel, model: ModelSummary | null): Promise<string> {
  const shot = engine.snapshot();
  const img = new Image();
  img.src = shot;
  await img.decode();
  const scale = Math.max(1, img.width / 1600);
  const band = Math.round(28 * scale);
  const cv = document.createElement("canvas");
  cv.width = img.width;
  cv.height = img.height + band * 2;
  const g = cv.getContext("2d")!;
  g.fillStyle = level.color;
  g.fillRect(0, 0, cv.width, band);
  g.fillRect(0, cv.height - band, cv.width, band);
  g.drawImage(img, 0, band);
  g.fillStyle = level.textColor;
  g.font = `600 ${Math.round(13 * scale)}px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif`;
  g.textAlign = "center";
  g.textBaseline = "middle";
  const label = level.label.toUpperCase();
  g.fillText(label, cv.width / 2, band / 2);
  g.fillText(label, cv.width / 2, cv.height - band / 2);
  // Caption, bottom left inside the image, on a dark plate so it reads on any scene.
  const c = engine.viewCentre();
  const caption = [model ? `${model.name} · v${model.version}` : "Earth", c ? `${c.lat.toFixed(5)}°, ${c.lon.toFixed(5)}°` : null, new Date().toLocaleString()].filter(Boolean).join("   ·   ");
  g.font = `500 ${Math.round(12 * scale)}px "IBM Plex Sans", "Segoe UI", system-ui, sans-serif`;
  g.textAlign = "left";
  const w = g.measureText(caption).width + 16 * scale;
  const h = 22 * scale;
  g.fillStyle = "rgba(0,0,0,0.55)";
  g.fillRect(8 * scale, cv.height - band - h - 8 * scale, w, h);
  g.fillStyle = "#fff";
  g.fillText(caption, 16 * scale, cv.height - band - 8 * scale - h / 2);
  return cv.toDataURL("image/png");
}
