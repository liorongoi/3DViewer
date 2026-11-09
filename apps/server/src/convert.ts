import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { PermanentError } from "./permanent.ts";

// Running the converter, shared by the server and the conversion sandbox's step runner
// (convert-step.ts), which must load without the rest of the server.

export function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : -1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

const fileSize = (p: string) => stat(p).then((s) => s.size, () => 0);

/** FBX → GLB with FBX2glTF (decision in docs/spikes/FBX_BAKEOFF.md). */
export const NO_FBX = "FBX conversion is not set up on this server. The administrator sets FBX2GLTF to the FBX2glTF program.";
export function needFbx(bin: string | undefined): string {
  if (!bin) throw new PermanentError(NO_FBX);
  return bin;
}

export async function convertFbx(bin: string | undefined, input: string, outDir: string): Promise<string> {
  if (!bin) throw new PermanentError(NO_FBX);
  await mkdir(outDir, { recursive: true });
  const base = path.join(outDir, path.basename(input).replace(/\.fbx$/i, ""));
  const r = await run(bin, ["--binary", "--input", input, "--output", base], 30 * 60_000);
  const out = `${base}.glb`;
  if (r.code !== 0 || !(await fileSize(out))) throw new PermanentError(`FBX2glTF could not convert the file: ${r.out.split("\n").slice(-3).join(" ").slice(0, 400) || `exit code ${r.code}`}`);
  return out;
}
