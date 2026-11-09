# Operations guide

How to install, configure, run, back up, restore and upgrade VIEWER on a site server. The files it refers to are in `deploy/`.

## What runs

| Part | What it is | Runs as |
|---|---|---|
| `viewer-server` | The Node server: the API, the audit log and the upload job workers. Listens on `127.0.0.1:8787`. | systemd service, user `viewer` |
| `viewer-caddy` | The HTTPS front end. It serves the web app, passes `/api/*` to the server and serves model files from storage, all on one origin. | systemd service, user `viewer` |
| PostgreSQL | The library, versions, settings and the audit log. Version 15 or newer. | Your database server |
| `viewer-backup.timer` | Backs up the database and the model files every night at 02:30. | systemd timer |

Data lives in `/var/lib/viewer` (`DATA_DIR`). Published model files are in `/var/lib/viewer/storage/files`; uploads in progress are in `storage/uploads` and `storage/ingests`.

## Install and upgrade

Install, upgrade and roll back from the offline server bundle with its `install.sh`: [INSTALL.md](./INSTALL.md) goes step by step. In short:

- the program is in `/opt/viewer-releases/<version>`, and `/opt/viewer` points at the one in use;
- the settings are `/etc/viewer/viewer.env` and `/etc/viewer/caddy.env`, the certificate is in `/etc/viewer/tls`;
- Node.js, Caddy and FBX2glTF come with the bundle; ClamAV, Chromium and the PostgreSQL client come from the operating system;
- base map packages go to `/var/lib/viewer/basemaps` with `viewer-basemap-install`.

The bundle is built on a machine with the repository and internet access, after `pnpm install --frozen-lockfile` and `pnpm -r run build`: `bash scripts/build-server-bundle.sh` writes `out/viewer-server-<version>-linux-x64.tar.gz`. `VIEWER_VERSION` sets the version.

## Settings

The server reads its settings from `/etc/viewer/viewer.env` when it starts. It checks every value: a wrong one stops it with exit code 78 and a message that names the setting (`systemctl status viewer-server` shows it). systemd does not restart it in a loop.

| Setting | Default | What it does |
|---|---|---|
| `DATABASE_URL` | none | PostgreSQL connection string, `postgres://user:password@host:5432/viewer`. Required in production. |
| `DATA_DIR` | `./data` | Where the server keeps its data. |
| `STORAGE_DIR` | `DATA_DIR/storage` | Uploads, unpacked uploads and published files. |
| `HOST`, `PORT` | `127.0.0.1`, `8787` | Where the server listens. Keep it on `127.0.0.1`: it trusts the client address that Caddy passes on. |
| `ADMIN_PASSWORD` | none | The first admin password, 12 characters or more. It is read on first start only. |
| `ADMIN_PASSWORD_RESET` | `0` | `1` replaces the stored password with `ADMIN_PASSWORD`. Use it once, then remove both lines. |
| `CORS_ORIGINS` | none | Other origins that may call the API, comma separated. `*` is refused in production. |
| `WORKERS` | `1` | `0` runs the API without job workers, for a site that runs workers on another machine. |
| `CLAMDSCAN` | none | Path of `clamdscan`. Without it, uploads are published with a "not scanned" warning. |
| `FBX2GLTF` | none | Path of FBX2glTF. Without it, FBX uploads fail. |
| `STRICT_VALIDATION` | `0` | `1` stops a publish when the official glTF or 3D Tiles validator finds errors. `0` shows them as warnings. |
| `JOB_LEASE_SECONDS` | `300` | How long before another worker takes up the job of a worker that died (10 to 86400). |
| `THUMBNAIL_WEB_URL`, `CHROMIUM` | none | Where the web app is served, and the Chromium binary, for library thumbnails. |
| `WRITE_RATE_LIMIT` | `600` | Changes one address may make per minute. Beyond it the server answers 429 with `Retry-After`. Upload chunks do not count. `0` turns the limit off. |
| `DB_STATEMENT_TIMEOUT_MS` | `60000` | The longest one database statement may run. A transaction left idle is ended after 5 minutes, and waiting for a database connection gives up after 10 s. |
| `AUDIT_SYSLOG` | none | Sends the audit log to the SIEM as CEF: `udp://`, `tcp://` or `tls://host:port`. |
| `SEED_SAMPLES` | `0` in production | Loads the sample library. For demonstrations only. |
| `EMBEDDED_DB` | `0` | `1` allows production without `DATABASE_URL`, on the embedded database. For a single workstation only. |
| `NODE_ENV` | set by the unit | `production` turns on the production checks. |

Caddy's settings (`/etc/viewer/caddy.env`) are described in `deploy/caddy/README.md`.

## Day to day

- **Start, stop, restart:** `systemctl start|stop|restart viewer-server`. On stop, the server finishes running requests and the current job step, for up to 30 s. A job still running after that is taken up again when its lease ends.
- **Logs:** `journalctl -u viewer-server` has one JSON line per request and event. Caddy's access log is `/var/log/viewer/caddy.log`, rolled at 100 MB with 10 files kept.
- **Health checks** for a load balancer or a monitor:
  - `GET /api/health` is the readiness check. It answers 200 when the database answers and storage can be written. Otherwise it answers 503 and says which one failed: `{"ok":false,"checks":{"database":"failed: …","storage":"ok"}}`.
  - `GET /api/health/live` only says the process answers.
- **Crashes:** a fault nothing caught is logged as `fatal` and the process exits. systemd starts it again after 5 s.
- **Disk:** watch the free space of `/var/lib/viewer` and `/var/backups/viewer`. The admin page (Storage) shows use against the quota.

## Backups

`viewer-backup` runs every night from `viewer-backup.timer` and writes `/var/backups/viewer/viewer-<UTC time>/`. Each backup holds:

- `database.dump`: a PostgreSQL dump (custom format);
- `files.tar`: every published model file and thumbnail;
- `MANIFEST`: the time, the source and a SHA-256 for each file.

It keeps the newest 14 backups; set `KEEP` to change that. The backup runs while the server is up: the database is dumped first, and published files are only ever added, never changed, so every file the dump names is in `files.tar`.

- Run one by hand with `sudo systemctl start viewer-backup`.
- The backup needs `pg_dump` of the same major version as the database server, or newer.
- **Copy backups off the machine.** `/var/backups/viewer` on the same disk does not survive a lost disk.
- Uploads in progress are not backed up. A user whose upload was cut off sends it again.
- The embedded database (`EMBEDDED_DB=1`) can only be backed up with the server stopped.

## Restore

1. `systemctl stop viewer-server`
2. `sudo -u viewer VIEWER_ENV=/etc/viewer/viewer.env viewer-restore /var/backups/viewer/viewer-<time> --yes`
3. `systemctl start viewer-server`, then check `/api/health` and open a model.

The restore does these steps:

- It checks every file against the MANIFEST first, and stops if anything is damaged.
- It saves the current database and files to `before-restore-<time>/` beside the backup, so a restore can be undone. Delete that folder once the restore is checked.
- It replaces the database and the published files.

Everything after the backup is lost, including the audit entries written since; they are in the `before-restore` copy. Keep that copy for as long as audit records must be kept (NFR-11). The audit log still refuses changes after a restore.

`apps/server/src/backup.e2e.test.ts` backs up, changes data, restores and compares, on the embedded database and on PostgreSQL. CI runs it on every pull request. Practise a restore on a test machine at least once a quarter.

## Upgrade

1. Read the release notes for the new version.
2. Back up: `systemctl start viewer-backup` (it returns when the backup is done).
3. From the new bundle's folder: `sudo ./install.sh`. It installs the new version beside the old one, switches `/opt/viewer` to it and restarts. If the new version does not start, it switches back by itself. On start the server applies new database migrations, each one in a transaction; the log line `database ready` lists them.
4. Check `/api/health`, open the app (browsers check `index.html` on every load, so users get the new version straight away), and open a model.

**Roll back:**

1. `sudo /opt/viewer/install.sh --rollback` switches to the version before and restarts it.
2. If the new version had changed the database, restore the backup from step 2 first (see *Restore*): an older version may not know the newer tables.

## Problems

| What you see | What it means | What to do |
|---|---|---|
| `viewer-server` stopped, `status=78` | A setting is wrong. | `systemctl status viewer-server` names it. Fix `/etc/viewer/viewer.env` and start the server again. |
| `/api/health` answers 503, database failed | The server cannot reach PostgreSQL, or a query takes over 3 s. | Check the database and `DATABASE_URL`. The server reconnects by itself. |
| `/api/health` answers 503, storage failed | Storage is full, read-only, or its permissions changed. | Free space, or fix the owner (`viewer`) of `/var/lib/viewer`. |
| Users see "Too many changes from this address" (429) | One address went past `WRITE_RATE_LIMIT`. This is usually a faulty script. | Find the address in the audit log. Raise the limit only if the use is real. |
| Admin password lost | | Set `ADMIN_PASSWORD` to a new password and `ADMIN_PASSWORD_RESET=1`, restart, sign in, then remove both lines. |
| Uploads say "not scanned for viruses" | `CLAMDSCAN` is not set. | Install ClamAV, set `CLAMDSCAN` and restart. |
