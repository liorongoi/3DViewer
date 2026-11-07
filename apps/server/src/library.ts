import type { LayerManifest, ModelSummary } from "@viewer/shared/model";
import type { Queryable } from "./db.ts";

/** WP 3.6: the library, in the same shape the client already uses (ModelSummary). */

interface ModelRow {
  id: string;
  name: string;
  project: string;
  operation: string;
  responsible_entity: string;
  description: string;
  status: ModelSummary["status"];
  status_changed_at: Date | string;
  classification_id: string;
  source_format: ModelSummary["sourceFormat"];
  centre_lat: number;
  centre_lon: number;
  current_version: number;
  versions: number | string;
  source: ModelSummary["source"];
  placement: ModelSummary["placement"] | null;
  size_bytes: number | string;
  thumbnail: string | null;
}

const SELECT = `
  SELECT m.*, v.source, v.placement, v.size_bytes, v.thumbnail,
         (SELECT count(*) FROM versions x WHERE x.model_id = m.id) AS versions
  FROM models m JOIN versions v ON v.model_id = m.id AND v.version = m.current_version
  WHERE m.deleted_at IS NULL`;

const day = (d: Date | string) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

export function toSummary(r: ModelRow): ModelSummary {
  return {
    id: r.id,
    name: r.name,
    project: r.project,
    operation: r.operation,
    responsibleEntity: r.responsible_entity,
    description: r.description,
    status: r.status,
    statusChangedAt: day(r.status_changed_at),
    classificationId: r.classification_id,
    version: r.current_version,
    versions: Number(r.versions),
    sourceFormat: r.source_format,
    source: r.source,
    centre: { lat: r.centre_lat, lon: r.centre_lon },
    ...(r.placement ? { placement: r.placement } : {}),
    sizeBytes: Number(r.size_bytes),
    ...(r.thumbnail ? { thumbnail: r.thumbnail } : {}),
  };
}

export interface LibraryFilter {
  q?: string;
  project?: string;
  operation?: string;
  status?: string;
  entity?: string;
  classification?: string;
}

export async function listModels(db: Queryable, f: LibraryFilter): Promise<ModelSummary[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, v: unknown) => {
    params.push(v);
    where.push(sql.replace("?", `$${params.length}`));
  };
  // Search across the metadata, case-insensitive; Hebrew has no case, so lower() is harmless there.
  if (f.q?.trim()) add("lower(m.name || ' ' || m.project || ' ' || m.operation || ' ' || m.responsible_entity || ' ' || m.description) LIKE ?", `%${f.q.trim().toLowerCase().replace(/[%_\\]/g, "\\$&")}%`);
  if (f.project) add("m.project = ?", f.project);
  if (f.operation) add("m.operation = ?", f.operation);
  if (f.status) add("m.status = ?", f.status);
  if (f.entity) add("m.responsible_entity = ?", f.entity);
  if (f.classification) add("m.classification_id = ?", f.classification);
  const rows = await db.query<ModelRow>(`${SELECT}${where.map((w) => ` AND ${w}`).join("")} ORDER BY m.updated_at DESC, m.name`, params);
  return rows.map(toSummary);
}

/** The model as it is now, or as it was at an earlier version (UPL-07: old versions stay openable). */
export async function getModel(db: Queryable, id: string, version?: number): Promise<ModelSummary | null> {
  if (version === undefined) {
    const [r] = await db.query<ModelRow>(`${SELECT} AND m.id = $1`, [id]);
    return r ? toSummary(r) : null;
  }
  const [r] = await db.query<ModelRow>(`${SELECT.replace("v.version = m.current_version", "v.version = $2")} AND m.id = $1`, [id, version]);
  return r ? { ...toSummary(r), version } : null;
}

export async function listVersions(db: Queryable, id: string) {
  const rows = await db.query<{ version: number; state: string; note: string; size_bytes: string | number; created_at: Date }>(
    "SELECT version, state, note, size_bytes, created_at FROM versions WHERE model_id = $1 ORDER BY version DESC",
    [id],
  );
  return rows.map((r) => ({ version: r.version, state: r.state, note: r.note, sizeBytes: Number(r.size_bytes), createdAt: new Date(r.created_at).toISOString() }));
}

export interface NewModel {
  id?: string;
  name: string;
  project?: string;
  operation?: string;
  responsibleEntity?: string;
  description?: string;
  status: ModelSummary["status"];
  classificationId: string;
  sourceFormat: ModelSummary["sourceFormat"];
  source: ModelSummary["source"];
  centre: { lat: number; lon: number };
  placement?: ModelSummary["placement"];
  sizeBytes?: number;
  statusChangedAt?: string;
  versions?: number;
}

export async function createModel(q: Queryable, m: NewModel): Promise<string> {
  const id = m.id ?? `m-${crypto.randomUUID()}`;
  await q.query(
    `INSERT INTO models (id, name, project, operation, responsible_entity, description, status, status_changed_at, classification_id, source_format, centre_lat, centre_lon, current_version)
     VALUES ($1,$2,$3,$4,$5,$6,$7,COALESCE($8::date, CURRENT_DATE),$9,$10,$11,$12,$13)`,
    [id, m.name, m.project ?? "", m.operation ?? "", m.responsibleEntity ?? "", m.description ?? "", m.status, m.statusChangedAt ?? null, m.classificationId, m.sourceFormat, m.centre.lat, m.centre.lon, m.versions ?? 1],
  );
  for (let v = 1; v <= (m.versions ?? 1); v++)
    await q.query("INSERT INTO versions (model_id, version, source, placement, size_bytes) VALUES ($1,$2,$3,$4,$5)", [id, v, JSON.stringify(m.source), m.placement ? JSON.stringify(m.placement) : null, m.sizeBytes ?? 0]);
  return id;
}

const EDITABLE = {
  name: "name",
  project: "project",
  operation: "operation",
  responsibleEntity: "responsible_entity",
  description: "description",
  status: "status",
  classificationId: "classification_id",
} as const;

export type ModelPatch = Partial<Record<keyof typeof EDITABLE, string>>;

/** Updates metadata and returns what changed, as before/after pairs for the audit log. */
export async function updateModel(q: Queryable, id: string, patch: ModelPatch): Promise<Record<string, [unknown, unknown]> | null> {
  const before = await getModel(q, id);
  if (!before) return null;
  const changes: Record<string, [unknown, unknown]> = {};
  const sets: string[] = [];
  const params: unknown[] = [id];
  for (const [k, col] of Object.entries(EDITABLE) as [keyof typeof EDITABLE, string][]) {
    const v = patch[k];
    if (v === undefined || v === (before as unknown as Record<string, unknown>)[k]) continue;
    params.push(v);
    sets.push(`${col} = $${params.length}`);
    changes[k] = [(before as unknown as Record<string, unknown>)[k], v];
  }
  if (!sets.length) return changes;
  if (changes.status) sets.push("status_changed_at = CURRENT_DATE");
  await q.query(`UPDATE models SET ${sets.join(", ")}, updated_at = now() WHERE id = $1`, params);
  return changes;
}

export async function addVersion(q: Queryable, id: string, v: { source: ModelSummary["source"]; placement?: ModelSummary["placement"]; sizeBytes?: number; note?: string }): Promise<number | null> {
  const [m] = await q.query<{ n: number }>("SELECT COALESCE(max(version), 0) + 1 AS n FROM versions WHERE model_id = $1", [id]);
  const [exists] = await q.query("SELECT 1 FROM models WHERE id = $1 AND deleted_at IS NULL", [id]);
  if (!exists || !m) return null;
  await q.query("INSERT INTO versions (model_id, version, source, placement, size_bytes, note) VALUES ($1,$2,$3,$4,$5,$6)", [
    id,
    m.n,
    JSON.stringify(v.source),
    v.placement ? JSON.stringify(v.placement) : null,
    v.sizeBytes ?? 0,
    v.note ?? "",
  ]);
  await q.query("UPDATE models SET current_version = $2, updated_at = now() WHERE id = $1", [id, m.n]);
  // The producer's layer arrangement carries over to the new version (WP 4.3); parts the new
  // file no longer has are skipped when it is applied, and new ones show after it.
  await q.query("INSERT INTO layer_manifests (model_id, version, manifest) SELECT model_id, $2, manifest FROM layer_manifests WHERE model_id = $1 AND version = $2 - 1", [id, m.n]);
  return m.n;
}

/** The saved layer arrangement of a version (the current one if left out), or null. */
export async function getManifest(q: Queryable, id: string, version?: number): Promise<{ version: number; manifest: LayerManifest | null } | null> {
  const [m] = await q.query<{ v: number }>("SELECT current_version AS v FROM models WHERE id = $1 AND deleted_at IS NULL", [id]);
  if (!m) return null;
  const v = version ?? m.v;
  const [ver] = await q.query("SELECT 1 FROM versions WHERE model_id = $1 AND version = $2", [id, v]);
  if (!ver) return null;
  const [row] = await q.query<{ manifest: LayerManifest | string }>("SELECT manifest FROM layer_manifests WHERE model_id = $1 AND version = $2", [id, v]);
  const manifest = row ? (typeof row.manifest === "string" ? (JSON.parse(row.manifest) as LayerManifest) : row.manifest) : null;
  return { version: v, manifest };
}

/** Saves the layer arrangement of the current version; null removes it. Returns that version. */
export async function setManifest(q: Queryable, id: string, manifest: LayerManifest | null): Promise<number | null> {
  const [m] = await q.query<{ v: number }>("SELECT current_version AS v FROM models WHERE id = $1 AND deleted_at IS NULL", [id]);
  if (!m) return null;
  if (manifest) await q.query("INSERT INTO layer_manifests (model_id, version, manifest) VALUES ($1, $2, $3) ON CONFLICT (model_id, version) DO UPDATE SET manifest = EXCLUDED.manifest", [id, m.v, JSON.stringify(manifest)]);
  else await q.query("DELETE FROM layer_manifests WHERE model_id = $1 AND version = $2", [id, m.v]);
  return m.v;
}

/** Why a manifest cannot be saved, or null when it can: too deep, too large, or not whole numbers. */
export function manifestProblem(m: LayerManifest): string | null {
  let count = 0;
  const rec = (ls: LayerManifest["layers"], depth: number): string | null => {
    if (depth > 64) return "The layers are nested more than 64 deep.";
    for (const l of ls) {
      if (++count > 100_000) return "There are more than 100,000 layers.";
      const r = rec(l.children ?? [], depth + 1);
      if (r) return r;
    }
    return null;
  };
  return rec(m.layers, 1);
}
