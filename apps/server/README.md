# VIEWER server (Phase 3)

Library API, versions and the audit log. Fastify on Node 22, PostgreSQL.

```sh
pnpm --filter @viewer/server dev          # embedded PostgreSQL (PGlite) in ./data, sample library seeded
DATABASE_URL=postgres://… pnpm --filter @viewer/server dev   # a real PostgreSQL
```

| Variable | Default | Meaning |
|---|---|---|
| `DATABASE_URL` | none | PostgreSQL connection. Without it the server uses embedded PGlite in `DATA_DIR`. |
| `DATA_DIR` | `./data` | PGlite data folder. |
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
| GET | `/api/audit/verify` | Recomputes the hash chain and names the first changed row |

## Audit (WP 3.8, NFR-11)

Every view and change is stored with time, IP and workstation, in the same transaction as the change. The desktop app sends the Windows computer name in `X-Workstation`; for browsers the server looks up the IP's DNS name (decision D-5). Each row holds the SHA-256 of the previous row's hash and its own content, so a changed or deleted row breaks the chain at that point.

## Not yet

Uploads (tus), validation and antivirus, the conversion workers (FBX2glTF, tiling) and thumbnails follow in WP 3.2–3.5; admin password and quotas in WP 3.9.
