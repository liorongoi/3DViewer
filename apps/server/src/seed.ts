import { SAMPLE_CLASSIFICATIONS, SAMPLE_LIBRARY } from "@viewer/shared/sample-library";
import { audit } from "./audit.ts";
import type { Db } from "./db.ts";
import { createModel } from "./library.ts";

/** First start: the classification levels, and optionally the sample library, so a fresh install shows something. */
export async function seed(db: Db, opts: { samples: boolean }): Promise<{ classifications: number; models: number }> {
  let classifications = 0;
  let models = 0;
  await db.tx(async (q) => {
    const [{ n }] = (await q.query<{ n: number }>("SELECT count(*)::int AS n FROM classifications")) as [{ n: number }];
    if (n === 0)
      for (const c of SAMPLE_CLASSIFICATIONS) {
        await q.query("INSERT INTO classifications (id, label, color, text_color, ord) VALUES ($1,$2,$3,$4,$5)", [c.id, c.label, c.color, c.textColor, c.order]);
        classifications++;
      }
    if (opts.samples) {
      const [{ m }] = (await q.query<{ m: number }>("SELECT count(*)::int AS m FROM models")) as [{ m: number }];
      if (m === 0)
        for (const s of SAMPLE_LIBRARY) {
          await createModel(q, { ...s, versions: s.versions });
          models++;
        }
    }
    if (classifications || models) await audit(q, { ip: "", host: "server", action: "system.seed", detail: { classifications, models } });
  });
  return { classifications, models };
}
