# Installing the HOLO server

This guide installs HOLO on a site server from the offline bundle, with no internet. It takes about an hour, most of it preparing the database and the certificate. Day-to-day running, backups and restores are in [OPERATIONS.md](./OPERATIONS.md).

## What you need

| | |
|---|---|
| **Server** | Linux on x86-64 with systemd: Ubuntu 22.04 or 24.04, Debian 12, or RHEL, Rocky or Alma 9. 8 cores, 32 GB of memory, and disk for the library (the models you expect, plus a third) and for the base maps. |
| **Database** | PostgreSQL 15 or newer, on this server or another. |
| **Name and certificate** | A DNS name for the server, such as `viewer.internal`, and the organisation's certificate for it: the full chain and the private key, both PEM. |
| **Ports** | 443 (and 80, which only redirects) open to the users' computers. |
| **The bundle** | `viewer-server-<version>-linux-x64.tar.gz` and its `.sha256`. |

From the operating system's own packages (the site's mirror), these are optional:

| Package | Without it |
|---|---|
| PostgreSQL client (`pg_dump`, same major version as the database or newer) | The nightly backup fails. Install it. |
| ClamAV (`clamdscan`, with `clamd` running) | Uploads are published with a "not scanned" warning. |
| Podman 4 or newer | Uploaded files are converted, validated and tiled in child processes of the server, not in a container with no network (see SECURITY.md). With podman installed, `install.sh` turns the container on. |
| Chromium | The library shows models without thumbnails. |

Everything else (Node.js, the Caddy web server, the FBX converter) is in the bundle.

## Without root: one server in a home folder

For a trial, a single team, or a machine where you have no admin rights. It needs no root, no
PostgreSQL and no certificate. The bundle's `README-FIRST.txt` walks through it for someone new
to Linux.

```sh
tar -xzf viewer-server-<version>-linux-x64.tar.gz
cd viewer-server-<version>-linux-x64
./deploy/bin/holo-check        # optional: what this machine can do; changes nothing
./install-user.sh              # installs in ~/holo, starts, prints the address and admin password
```

- **Where:** everything is under `~/holo` (or `--dir`): `releases/` and `current` (the program), `settings/` (mode 700), `data/` (the built-in database and models), `logs/`, `backups/`. Nothing is written outside it except `~/.local/bin/holo` and, where used, your own crontab or per-user systemd units.
- **Database:** the built-in one (`EMBEDDED_DB=1`), unless `--database-url` names a PostgreSQL database.
- **Address:** plain HTTP on port 8080 (or the next free one, or `--port`). With `--cert` and `--key` it serves HTTPS on 8443, with 8080 redirecting. Ports under 1024 need root, so they are not offered.
- **Running:** with systemd 240 or newer and "linger" for the user, as per-user services (restart after a crash, start at boot). Otherwise `holo` runs the server and Caddy in a restart loop and starts them at boot from the user's crontab. A nightly backup runs at 02:30; with the built-in database it stops the server for about a minute.
- **The `holo` command:** `status`, `start`, `stop`, `restart`, `address`, `check`, `logs`, `report`, `backup`, `password`, `uninstall`. `holo report` writes a support file with the hardware check and recent logs, with network addresses, host names, user names, e-mails and home paths taken out.
- **Upgrade:** run `./install-user.sh` from the newer bundle. Settings and data are kept. If the new version does not start, it goes back to the old one.
- **Limits:** the conversion sandbox (podman) is off, and uploads are not virus-scanned unless `clamdscan` is installed. For a shared site server, use the root install below.
- **Check:** `scripts/check-user-install.sh` (CI) installs as an ordinary user, signs in, stops, starts, backs up, writes a report, upgrades and uninstalls.

### Making splats on this server: the building add-on

`holo-building-<version>-linux-x64.tar.gz` holds what turns a video or photos into Gaussian splats: Python 3.12 with pycolmap (camera poses, on the processor), ffmpeg (video frames) and Brush (building through Vulkan on any NVIDIA, AMD or Intel graphics card). Brush is built from its own source with one HOLO addition, a penalty on long, thin splats (`scripts/brush/needle-penalty.patch`); HOLO switches it on whenever the installed Brush has it. As the same user:

```sh
tar -xzf holo-building-<version>-linux-x64.tar.gz
cd holo-building-<version>-linux-x64
./install-building.sh          # or --dir for HOLO elsewhere
```

It unpacks into `~/holo/training/<version>`, writes `settings/holo-worker.json`, sets `SPLAT_WORKERS=brush=…` in `settings/viewer.env`, restarts HOLO and runs `holo test-building`: 300 Brush steps on a made-up scene (`workers/selftest/make_sample.py`), with the time it took. Brush needs the graphics driver's Vulkan part (on NVIDIA it comes with the driver); if the test is slow, Brush is drawing on the processor. Checked by `scripts/check-building-install.sh` in the release workflow (Mesa's software Vulkan on the runner), and once by hand here: a 10 s orbit video uploaded through the API went through frames and camera poses (153 of 153 frames posed) into a Brush build, on a machine with no graphics card (Mesa's software Vulkan).

## 1. Copy the bundle and check it

Copy both files to the server, then:

```sh
sha256sum -c viewer-server-<version>-linux-x64.tar.gz.sha256
tar -xzf viewer-server-<version>-linux-x64.tar.gz
cd viewer-server-<version>-linux-x64
```

`sha256sum` must print `OK`. If it does not, the copy is damaged: copy it again.

## 2. Prepare the database

On the database server, as the PostgreSQL superuser:

```sql
CREATE ROLE viewer LOGIN PASSWORD '<a long random password>';
CREATE DATABASE viewer OWNER viewer ENCODING 'UTF8' TEMPLATE template0;
```

Allow the HOLO server to connect in `pg_hba.conf` (for example `hostssl viewer viewer <server address>/32 scram-sha-256`) and reload PostgreSQL. HOLO creates its own tables on first start.

The address HOLO uses is then `postgres://viewer:<password>@<database host>:5432/viewer`. If the password has characters such as `@`, `/` or `:`, write them percent-encoded (`@` is `%40`).

## 3. Install

As root, from the unpacked bundle:

```sh
sudo ./install.sh --host viewer.internal \
  --database-url 'postgres://viewer:<password>@db.internal:5432/viewer' \
  --cert /path/to/viewer-chain.pem --key /path/to/viewer.key
```

It:

1. checks the bundle against its checksums;
2. creates the system user `viewer` and the folders: `/var/lib/viewer` (data), `/var/log/viewer`, `/var/backups/viewer` and `/etc/viewer` (settings);
3. copies the program to `/opt/viewer-releases/<version>`, and points `/opt/viewer` at it;
4. writes the settings `/etc/viewer/viewer.env` and `/etc/viewer/caddy.env`, with a new random first admin password;
5. installs the certificate in `/etc/viewer/tls`;
6. installs and starts the services `viewer-server`, `viewer-caddy` and the nightly `viewer-backup.timer`;
7. waits until the server answers, and prints the address.

**Write down the first admin password it prints.** It is also in `/etc/viewer/first-admin-password`, readable by root only.

If something is missing, such as the database address, it installs the files, says what to fill in, and does not start. Fill it in (`/etc/viewer/viewer.env`, or the options above) and run `./install.sh` again. Running it again is always safe: settings that exist are never overwritten.

If the server does not start, `install.sh` shows its last messages. A wrong setting stops it with a message naming the setting; `journalctl -u viewer-server -n 50` shows it again.

## 4. Check it works

1. On the server: `curl -fsS http://127.0.0.1:8787/api/health` answers `{"ok":true, ...}`.
2. From a user's computer: `https://viewer.internal/` opens HOLO, with the browser showing the certificate as trusted.
3. Open Settings, then **Administration…**, and sign in with the first admin password. Change it on the **Password** tab.
4. Then, on the server:
   ```sh
   sudo sed -i '/^ADMIN_PASSWORD=/d' /etc/viewer/viewer.env
   sudo rm /etc/viewer/first-admin-password
   ```
   The password is stored in the database; the admin page changes it from now on.
5. Upload a model (any `.glb`) from the library. It is checked and published within a minute (with a thumbnail when Chromium is installed).
6. Run one backup by hand and check it finished:
   ```sh
   sudo systemctl start viewer-backup && ls /var/backups/viewer
   ```

## 5. Base maps

Without the internet, the viewer's built-in base maps cannot load. The site's own imagery and terrain come as a **base map package** (`<name>-<version>.basemap.tar`), made from the organisation's orthophotos and elevation model (see *Making a base map package* below). To install one:

```sh
sudo viewer-basemap-install israel-2026.1.basemap.tar --register
```

It checks every file in the package, puts it in `/var/lib/viewer/basemaps/<name>`, and with `--register` signs in as admin (it asks for the password) and adds the package's imagery and terrain to the admin page's base maps, as the default if none is set. Without `--register`, it prints the sources for you to add on the admin page (**Base maps**).

Then, on the admin page, **Base maps**: tick *Hide the internet sources* so users only see the ones that work here.

- A newer package of the same name replaces the old one in one step: `viewer-basemap-install israel-2026.2.basemap.tar`.
- `viewer-basemap-install --list` shows what is installed; `--remove <name>` removes one (remove its sources on the admin page too).
- An existing map server on the network (WMTS, XYZ or TMS) needs no package: add its address on the admin page.

## 6. The desktop app

Give IT the Windows installer and the server's address. They install it silently for each user:

```
HOLO-Setup-<version>.exe /S /SERVER_URL=https://viewer.internal
```

Or set the address for a whole machine, by `%ProgramData%\VIEWER\viewer.json` or the `ServerUrl` registry value (Group Policy); `apps/desktop/README.md` has the details. The certificate must be trusted by Windows (the organisation's root in the machine's store).

Online maps (Esri, OpenStreetMap and the like, and services users add) work in the app by default. On a site with no internet connection, turn them off for the machine: `{"onlineMaps": false}` in `%ProgramData%\VIEWER\viewer.json`, or the registry value `OnlineMaps` = 0 under `HKLM\Software\VIEWER`. Then the app makes no connection except to the server.

### Building splats on a Windows PC, without the server

Each release also has `holo-building-<version>-windows-x64.zip`. It lets HOLO for Windows build splats on the PC's own NVIDIA card. Give it to the user, or put it on a share. In HOLO the user opens Make a splat ▸ Build on this PC ▸ Choose the add-on zip. It installs for that user only, with no admin rights and no internet. It needs about 1 GB of space, and a current NVIDIA driver (Vulkan is part of it). Docs: GAUSSIAN_SPLATS.md, "Build on this PC".

## Upgrade

Copy and check the new bundle (step 1), then from its folder:

```sh
sudo ./install.sh
```

It keeps the settings, installs the new version beside the old one, switches to it, and restarts. If the new version does not start, it switches back to the old one by itself and says so. The database is upgraded by the new version on its first start. Take a backup first (`sudo systemctl start viewer-backup`): going back to an older version after the database was upgraded needs that backup.

To go back to the version before by hand:

```sh
sudo /opt/viewer/install.sh --rollback
```

The three newest versions are kept in `/opt/viewer-releases`.

## Uninstall

```sh
sudo systemctl disable --now viewer-server viewer-caddy viewer-backup.timer
sudo rm /etc/systemd/system/viewer-*.service /etc/systemd/system/viewer-backup.timer /usr/local/sbin/viewer-*
sudo rm -r /opt/viewer /opt/viewer-releases
```

This leaves the data (`/var/lib/viewer`), the backups (`/var/backups/viewer`), the settings (`/etc/viewer`) and the database. Remove them only when you are sure.

## Making a base map package

On any Linux machine with GDAL and Node.js, from the organisation's data:

1. Imagery, from orthophotos (GeoTIFF):
   ```sh
   gdal2tiles.py --xyz -z 8-18 --processes 8 ortho.tif ortho-xyz/
   ```
2. Terrain, from the elevation model (GeoTIFF or DTED), with Cesium terrain builder (`ctb-tile`):
   ```sh
   ctb-tile -f Mesh -C -N -o dem-qm/ dem.tif
   ctb-tile -f Mesh -C -N -l -o dem-qm/ dem.tif
   ```
3. The package, from the repository:
   ```sh
   bash scripts/build-basemap-package.sh --name israel --version 2026.1 \
     --imagery ortho-xyz --imagery-label "Orthophoto 2026" \
     --terrain dem-qm --terrain-label "Elevation 2 m" --attribution "Survey of Israel"
   ```
   It writes `out/israel-2026.1.basemap.tar` and its `.sha256`. `--help` lists the other tile layouts it takes (TMS imagery, Terrarium terrain).
