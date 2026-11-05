// Runs the tiler on its own thread, so the server keeps answering while a large model tiles
// (WP 3.4). Started by tileModelInWorker in tiler.ts.
import { parentPort, workerData } from "node:worker_threads";
import { tileModel, type TileOptions } from "./tiler.ts";

const { file, outDir, opts } = workerData as { file: string; outDir: string; opts: TileOptions };
tileModel(file, outDir, opts, (done, total) => parentPort!.postMessage({ type: "progress", done, total })).then(
  (result) => parentPort!.postMessage({ type: "done", result }),
  (e: unknown) => parentPort!.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) }),
);
