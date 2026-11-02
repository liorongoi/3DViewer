# VIEWER server (Phase 3)

Library API, versions and the audit log. Fastify on Node 22, PostgreSQL.

```sh
pnpm --filter @viewer/server dev          # embedded PostgreSQL (PGlite) in ./data, sample library seeded
DATABASE_URL=postgres://… pnpm --filter @viewer/server dev   # a real PostgreSQL
```

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | none | PostgreSQL connection. Without it the server uses embedded PGlite in `DATA_DIR`. |
| `DATA_DIR` | `./data` | PGlite database in `DATA_DIR/db`, files in `DATA_DIR/storage`. |
| `STORAGE_DIR` | `DATA_DIR/storage` | Uploads in progress, unpacked ingests and published model files. |
| `CLAMDSCAN` | none | Path to `clamdscan`. Without it uploads are not scanned and each report says so. |
| `FBX2GLTF` | none | Path to the FBX2glTF program. Without it FBX uploads fail with a clear reason. |
| `CORS_ORIGINS` | none | Comma-separated origins allowed to call the API from elsewhere (the desktop app, a separate web host); `*` allows any. |
| `THUMBNAIL_WEB_URL` | none | Address of the web app the thumbnail renderer opens (for example `http://localhost:5173`). Without it no thumbnails are made and library cards show a plain tile. |
| `CHROMIUM` | Playwright's own | Path to a Chromium for thumbnails. Needs the optional `playwright-core` package. |
| `STRICT_VALIDATION` | `0` | `1` makes errors from the official glTF and 3D Tiles validators block publishing. By default they are listed in the report as warnings, because many real tilesets break a rule and still load (Lyon's has 72 misaligned tiles). |
| `WORKERS` | `1` | `0` runs the API without the conversion worker. |
| `SEED_SAMPLES` | `1` | `0` starts with an empty library (classification levels are always seeded once). |
| `HOST`, `PORT` | `127.0.0.1`, `8787` | Listen address. |

## API

The OpenAPI description is at `/api/openapi.json`.

| Method | Path | What it does |
|---|---|---|
| GET | `/api/health` | Server and database kind |
| GET | `/api/classifications` | Classification levels (name, colour, text colour, order) |
| GET | `/api/models?q=&project=&operation=&status=&entity=&classification=` | Library search and filters (Hebrew and English) |
| GET | `/api/models/:id` | One model with its version history (audited as `model.view`) |
| POST | `/api/models` | New model; classification required |
| PATCH | `/api/models/:id` | Edit metadata; status changes set the status date |
| POST | `/api/models/:id/versions` | New version becomes current; older ones are kept |
| GET | `/api/audit?from=&to=&action=&target=&limit=` | Audit events, newest first |
| GET | `/api/audit.csv` | CSV export (the export itself is audited) |
| POST | `/api/ingests` | Starts an upload: the files and the new model (or `modelId` for a new version). Returns one tus URL per file |
| HEAD / PATCH | `/api/tus/:id` | tus 1.0 resumable upload: HEAD gives the offset, PATCH appends from it |
| POST | `/api/ingests/:id/submit` | Queues the check, scan, conversion and publish |
| GET | `/api/ingests/:id` | Upload progress, state, the check report and the model it became |
| GET | `/files/:model/:ingest/…` | Published model files, immutable, with ETag and range requests |
| GET | `/api/audit/verify` | Recomputes the hash chain and names the first changed row |

## Audit (WP 3.8, NFR-11)

Every view and change is stored with time, IP and workstation, in the same transaction as the change. The desktop app sends the Windows computer name in `X-Workstation`; for browsers the server looks up the IP's DNS name (decision D-5). Each row holds the SHA-256 of the previous row's hash and its own content, so a changed or deleted row breaks the chain at that point.

## Uploads and ingest (WP 3.2–3.4, 3.7)

1. The client names the files; each is sent with tus, so a dropped connection resumes from the last byte the server has.
2. On submit a job joins the PostgreSQL queue. A worker leases it and renews the lease while it works; if the worker dies, the lease runs out and the job is taken again. Failures retry with backoff (10 s, 20 s, 40 s); a damaged file or a missing converter fails at once.
3. The job unpacks zips without trusting them: each name must stay inside the upload, sizes are counted as they inflate, and an entry that expands over 1000 times is stopped as a zip bomb.
4. It checks the files with the same loaders the browser uses (`@viewer/core/loaders`), so the report is the one the upload wizard shows. Every problem is listed.
5. ClamAV scans the files when `CLAMDSCAN` is set. FBX is converted to GLB with FBX2glTF.
6. Files are published under `files/<model>/<ingest>/`. The model or version, its report and the audit row are written in one transaction.

## Not yet

Tiling large meshes and thumbnails follow in WP 3.5. The admin password and quotas come in WP 3.9.
