/** Saves text as a file through the browser's download (web) or save dialog (desktop shell). */
export function saveText(name: string, text: string, type = "text/csv;charset=utf-8"): void {
  // The BOM lets Excel open Hebrew and accented names correctly.
  const blob = new Blob(["﻿", text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Saves binary data (for example a GeoTIFF) the same way. */
export function saveBytes(name: string, data: ArrayBuffer, type = "application/octet-stream"): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** File-safe name: letters, digits, dash. */
export const slug = (s: string) => s.replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "").toLowerCase() || "export";

/** Saves a data URL (for example a PNG screenshot). */
export function saveDataUrl(name: string, dataUrl: string): void {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
}
