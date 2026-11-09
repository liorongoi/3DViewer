import type { Db, Queryable } from "./db.ts";

/**
 * Job queue in PostgreSQL (WP 3.4). A worker takes a job with a lease; while it works it
 * renews the lease. If the worker process dies, the lease runs out and another worker
 * (or the same one after restart) takes the job again. Failed attempts retry with backoff.
 */
export interface Job {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

import { PermanentError } from "./permanent.ts";

export { PermanentError };

export async function enqueue(q: Queryable, kind: string, payload: Record<string, unknown>, maxAttempts = 3): Promise<string> {
  const [r] = await q.query<{ id: string }>("INSERT INTO jobs (kind, payload, max_attempts) VALUES ($1, $2, $3) RETURNING id", [kind, JSON.stringify(payload), maxAttempts]);
  return String(r!.id);
}

export type Handler = (job: Job, ctx: { progress: (p: Record<string, unknown>) => Promise<void> }) => Promise<void>;

export class Worker {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<void> | null = null;
  constructor(
    private db: Db,
    private handlers: Record<string, Handler>,
    private opts: { leaseSeconds?: number; pollMs?: number; onError?: (e: unknown, job: Job) => void } = {},
  ) {}

  /** Takes one ready job, or returns null. Expired leases count as ready. */
  async claim(): Promise<Job | null> {
    const lease = this.opts.leaseSeconds ?? 300;
    const [job] = await this.db.query<Job>(
      `UPDATE jobs SET state = 'running', attempts = attempts + 1, lease_until = now() + ($1 || ' seconds')::interval, updated_at = now()
       WHERE id = (
         SELECT id FROM jobs
         WHERE kind = ANY($2) AND run_after <= now() AND (state = 'queued' OR (state = 'running' AND lease_until < now()))
         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
       RETURNING id, kind, payload, attempts, max_attempts`,
      [String(lease), Object.keys(this.handlers)],
    );
    return job ? { ...job, id: String(job.id) } : null;
  }

  /** Runs one job if there is one. Returns whether it ran one. */
  async runOnce(): Promise<boolean> {
    const job = await this.claim();
    if (!job) return false;
    const lease = this.opts.leaseSeconds ?? 300;
    const renew = setInterval(() => {
      void this.db.query("UPDATE jobs SET lease_until = now() + ($2 || ' seconds')::interval WHERE id = $1 AND state = 'running'", [job.id, String(lease)]);
    }, (lease * 1000) / 3);
    try {
      await this.handlers[job.kind]!(job, {
        progress: async (p) => void (await this.db.query("UPDATE jobs SET progress = $2, updated_at = now() WHERE id = $1", [job.id, JSON.stringify(p)])),
      });
      await this.db.query("UPDATE jobs SET state = 'done', lease_until = NULL, error = NULL, updated_at = now() WHERE id = $1", [job.id]);
    } catch (e) {
      this.opts.onError?.(e, job);
      const msg = e instanceof Error ? e.message : String(e);
      const final = e instanceof PermanentError || job.attempts >= job.max_attempts;
      await this.db.query(
        `UPDATE jobs SET state = $2, error = $3, lease_until = NULL, run_after = now() + ($4 || ' seconds')::interval, updated_at = now() WHERE id = $1`,
        [job.id, final ? "failed" : "queued", msg, String(2 ** job.attempts * 5)],
      );
    } finally {
      clearInterval(renew);
    }
    return true;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const tick = async () => {
      if (!this.running) return;
      this.busy = (async () => {
        try {
          while (this.running && (await this.runOnce()));
        } catch (e) {
          this.opts.onError?.(e, { id: "", kind: "", payload: {}, attempts: 0, max_attempts: 0 });
        }
      })();
      await this.busy;
      if (this.running) this.timer = setTimeout(() => void tick(), this.opts.pollMs ?? 1000);
    };
    void tick();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.busy;
  }
}
