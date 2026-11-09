// One step of an upload's processing, run on its own inside the conversion sandbox (sandbox.ts):
// converting an FBX, the official validator, tiling or optimising. It reads the step as JSON from
// argv and writes JSON lines to stdout: {"type":"progress",...} while it works, then one
// {"type":"done","result":...} or {"type":"error","message":...}. The probe step reports what the
// sandbox allows, for the server's check at start.
import { connect } from "node:net";
import { lookup } from "node:dns/promises";
import { writeFile } from "node:fs/promises";
import { convertFbx } from "./convert.ts";
import { optimiseGlb } from "./optimise.ts";
import { tileModel } from "./tiler.ts";
import { runValidator } from "./validate.ts";
import type { Step } from "./sandbox.ts";

const say = (m: Record<string, unknown>) => new Promise<void>((r) => process.stdout.write(JSON.stringify(m) + "\n", () => r()));

async function probe(work: string) {
  // An address reserved for documentation: it must not even be routable.
  const network = await new Promise<string>((resolve) => {
    const s = connect({ host: "192.0.2.1", port: 80, timeout: 3000 });
    s.once("connect", () => (s.destroy(), resolve("connected")));
    s.once("timeout", () => (s.destroy(), resolve("timeout")));
    s.once("error", (e: NodeJS.ErrnoException) => resolve(e.code ?? e.message));
  });
  const dns = await lookup("example.com").then(() => "resolved", (e: NodeJS.ErrnoException) => e.code ?? e.message);
  const rootWritable = await writeFile("/viewer-probe", "x").then(() => true, () => false);
  const workWritable = await writeFile(`${work}/.probe`, "x").then(() => true, () => false);
  return { network, dns, rootWritable, workWritable, uid: process.getuid?.() };
}

async function run(step: Step) {
  switch (step.task) {
    case "fbx":
      return { out: await convertFbx(step.bin, step.input, step.outDir) };
    case "validate":
      return runValidator(step.kind, step.file, step.timeoutMs);
    case "tile":
      return tileModel(step.file, step.outDir, step.opts, (done, total) => void say({ type: "progress", done, total }));
    case "optimise":
      return optimiseGlb(step.file, step.outFile);
    case "probe":
      return probe(step.work);
  }
}

const step = JSON.parse(process.argv[2] ?? "{}") as Step;
run(step).then(
  async (result) => (await say({ type: "done", result }), process.exit(0)),
  async (e: unknown) => (await say({ type: "error", message: e instanceof Error ? e.message : String(e), permanent: e instanceof Error && e.name === "PermanentError" }), process.exit(1)),
);
