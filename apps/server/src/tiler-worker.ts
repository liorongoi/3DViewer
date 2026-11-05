// Runs the heavy model work on its own thread, so the server keeps answering meanwhile
// (WP 3.4): tiling, and optimising a GLB. Started by runInWorker in tiler.ts.
import { parentPort, workerData } from "node:worker_threads";
import { optimiseGlb } from "./optimise.ts";
import { tileModel, type TileOptions } from "./tiler.ts";

type Job = { task: "tile"; file: string; outDir: string; opts: TileOptions } | { task: "optimise"; file: string; outFile: string };
const job = workerData as Job;
const work =
  job.task === "tile"
    ? tileModel(job.file, job.outDir, job.opts, (done, total) => parentPort!.postMessage({ type: "progress", done, total }))
    : optimiseGlb(job.file, job.outFile);
work.then(
  (result) => parentPort!.postMessage({ type: "done", result }),
  (e: unknown) => parentPort!.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) }),
);
