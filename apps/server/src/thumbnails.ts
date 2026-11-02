import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ClassificationLevel, ModelSummary } from "@viewer/shared/model";
import type { Db } from "./db.ts";
import { PermanentError, type Handler } from "./jobs.ts";
import { getModel } from "./library.ts";
import type { Storage } from "./storage.ts";
import type { Browser } from "playwright-core";

/**
 * Thumbnails (WP 3.5, UPL-08). After a version is published, a "thumbnail" job renders a
 * 24-frame turntable sprite with the classification band burned in, using the viewer itself
 * (packages/core in headless Chromium), so the card looks like the model does in the viewer.
 */
export interface Renderer {
  /** Returns the sprite as WebP bytes, or null when the model has nothing to show. */
  render(model: ModelSummary, level: ClassificationLevel | null): Promise<Uint8Array | null>;
  close?(): Promise<void>;
}

export interface ChromiumOptions {
  /** The web app, served so that "files/…" resolves on the same origin (Caddy in production, vite preview in development). */
  webUrl: string;
  /** Chromium binary; Playwright's own when unset. */
  executablePath?: string;
  timeoutMs?: number;
}

/** Headless Chromium through playwright-core, one browser reused across jobs. */
export function chromiumRenderer(opts: ChromiumOptions): Renderer {
  let browser: Promise<Browser> | null = null;
  const launch = async (): Promise<Browser> => {
    const pw = await import("playwright-core");
    // Software GL so it runs on a server with no GPU.
    return pw.chromium.launch({ executablePath: opts.executablePath, args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  };
  return {
    async render(model, level) {
      browser ??= launch();
      const page = await (await browser).newPage({ viewport: { width: 640, height: 360 } });
      try {
        const timeout = opts.timeoutMs ?? 120_000;
        await page.goto(`${opts.webUrl.replace(/\/$/, "")}/?render-only`, { waitUntil: "load", timeout });
        await page.waitForFunction("!!window.viewerEngine && !!window.__renderTurntable", null, { timeout });
        const arg = { model: { ...model, source: { ...model.source, url: new URL(model.source.url, opts.webUrl.replace(/\/?$/, "/")).href } }, level };
        const url: string | null = await page.evaluate(
          (a) => (globalThis as unknown as { __renderTurntable: (m: unknown, l: unknown) => Promise<string | null> }).__renderTurntable(a.model, a.level),
          arg,
        );
        return url ? new Uint8Array(Buffer.from(url.split(",")[1]!, "base64")) : null;
      } finally {
        await page.close();
      }
    },
    async close() {
      if (browser) await (await browser).close();
      browser = null;
    },
  };
}

export function thumbnailHandler(db: Db, storage: Storage, renderer: Renderer): Handler {
  return async (job) => {
    const modelId = String(job.payload.modelId);
    const version = Number(job.payload.version);
    const m = await getModel(db, modelId);
    if (!m) throw new PermanentError(`Model ${modelId} does not exist.`);
    // Render the version the job names, even if a newer one is current by now.
    const [v] = await db.query<{ source: ModelSummary["source"]; placement: ModelSummary["placement"] | null }>("SELECT source, placement FROM versions WHERE model_id = $1 AND version = $2", [modelId, version]);
    if (!v) throw new PermanentError(`Model ${modelId} has no version ${version}.`);
    const [c] = await db.query<{ id: string; label: string; color: string; text_color: string; ord: number }>("SELECT * FROM classifications WHERE id = $1", [m.classificationId]);
    const level = c ? { id: c.id, label: c.label, color: c.color, textColor: c.text_color, order: c.ord } : null;
    const bytes = await renderer.render({ ...m, version, source: v.source, ...(v.placement ? { placement: v.placement } : {}) }, level);
    if (!bytes) throw new PermanentError("The model rendered empty, so there is no thumbnail.");
    const rel = `${modelId}/thumbs/v${version}.webp`;
    const out = path.join(storage.files, rel);
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, bytes);
    await db.query("UPDATE versions SET thumbnail = $3 WHERE model_id = $1 AND version = $2", [modelId, version, `files/${rel}`]);
  };
}
