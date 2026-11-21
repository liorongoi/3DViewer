import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { redactor } from "./redact.ts";

/**
 * One log file per training run (docs/OPERATIONS.md, "Debug log"): what HOLO asked for, what the
 * worker said, how it ended. Written already redacted, so nothing about the network or the people
 * around the server is kept on disk for a log, and the newest 30 are kept.
 */

const KEEP = 30;

export async function writeTrainingLog(dir: string, name: string, lines: string[], known: string[] = []): Promise<void> {
  const r = redactor(known);
  await mkdir(dir, { recursive: true });
  const safe = name.replace(/[^\w.-]+/g, "_").slice(0, 120);
  await writeFile(path.join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}-${safe}.log`), r(lines.join("\n")) + "\n");
  const all = (await readdir(dir)).filter((f) => f.endsWith(".log")).sort();
  for (const f of all.slice(0, Math.max(0, all.length - KEEP))) await rm(path.join(dir, f), { force: true });
}

/** The newest `n` training logs, newest first, each cut to its last `maxBytes`. */
export async function readTrainingLogs(dir: string, n = 10, maxBytes = 200_000): Promise<{ name: string; text: string }[]> {
  const all = (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".log")).sort().reverse().slice(0, n);
  const out: { name: string; text: string }[] = [];
  for (const f of all) {
    const s = await stat(path.join(dir, f)).catch(() => null);
    if (!s?.isFile()) continue;
    let text = await readFile(path.join(dir, f), "utf8");
    if (text.length > maxBytes) text = `[… first ${text.length - maxBytes} characters left out …]\n${text.slice(-maxBytes)}`;
    out.push({ name: f, text });
  }
  return out;
}
