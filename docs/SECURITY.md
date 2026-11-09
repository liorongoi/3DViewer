# Security controls and evidence

For the accreditation package (WP 6.4). Each section says what VIEWER does, how it is checked, and where the evidence is. The checks run in CI on every change. Their output (logs, screenshots and the packet capture) is kept as build artifacts.

## No outbound connections (NFR-12, C-1, AC-10)

VIEWER needs nothing from the internet:
- Fonts, icons, the sample data and the base maps used inside the network all ship with it.
- Base maps and terrain come from the site's own sources (`viewer-basemap-install`).
- The built-in online sources (Esri, EOX, OpenStreetMap, AWS terrain) are offered only as a choice. They are never the default. An administrator can hide them with **Hide online sources**.
- The desktop app refuses every network request except to the configured VIEWER server.

**Evidence: `scripts/check-outbound.sh`** (CI job `browser (outbound)`, artifact `check-out/outbound/`).

How it runs:
- The server, the web app and a browser run in a network namespace of their own.
- Every address outside the machine is routed onto that namespace's loopback interface. So any attempt to reach one, and any DNS lookup, becomes a packet that `tcpdump` records. Local traffic between the processes is left out.
- A control connection to 192.0.2.1 is made first, and the capture must see it. A capture that sees nothing therefore cannot pass.

The session, in English and then in Hebrew, covers:
- the library;
- a model from the server, with each side tab, the layers and the map data;
- every base map and terrain not marked online;
- settings, help and the command palette;
- uploading and publishing a model, with the server's checks and conversion;
- signing in as administrator and opening each admin section.

It then turns on **Hide online sources** and checks that the pickers offer no online source.

The check fails on any packet other than the control. It also fails on any browser request to a host other than the web app and the server. The evidence files are:
- `capture.pcap`, the whole capture, for Wireshark;
- `capture.txt`, the capture as text;
- `requests.txt`, every request the browser made.

The desktop app's refusal of other hosts is checked by `scripts/check-desktop.cjs` (CI job `browser (accuracy)`).

## TLS (NFR-13)

Caddy serves VIEWER over HTTPS with the organisation's certificate:
- **Protocols:** only TLS 1.2 and TLS 1.3.
- **TLS 1.2 suites:** only forward-secret AEAD ones (ECDHE with AES-GCM or ChaCha20-Poly1305). This is Caddy's default.
- **HTTP:** plain HTTP is redirected to HTTPS.
- **Headers:** responses carry HSTS and `X-Content-Type-Options: nosniff`.

**Evidence: `scripts/check-server-install.sh`** (CI job `server-install`). On a clean install from the offline bundle, it checks:
- TLS 1.2 and TLS 1.3 are accepted, and TLS 1.1 is refused;
- an ECDHE AES-GCM suite is accepted;
- every non-AEAD suite and every static-RSA suite is refused;
- the redirect and both headers.

## Software bill of materials and licences (C-2)

Each release carries `sbom.cdx.json` (CycloneDX 1.6, made by `scripts/sbom.cjs`):
- **Server bundle:** `/opt/viewer/sbom.cdx.json`. It lists the server's and the web app's npm packages, FBX2glTF, Node.js and Caddy.
- **Desktop app:** `resources\sbom.cdx.json` in the install folder. It lists the web app's packages, FBX2glTF, and Electron (with the Chromium and Node.js it is built with).

npm packages carry their version, licence and registry hash.

The conversion sandbox's root (`sandbox/rootfs`) holds only the C libraries copied from the build machine (glibc, libstdc++, libgcc). It is not in the SBOM either; the bundle's `SHA256SUMS` covers it.

Operating-system packages that the server uses are not in it. These are PostgreSQL, ClamAV and Chromium (for thumbnails). They come from the operating system's own package inventory.

`THIRD_PARTY_LICENSES.md` lists every shipped package with its licence text. Both the SBOM and the licence report fail the build on a licence outside the allowed list in `scripts/licenses.cjs`. That list has permissive licences, OFL for fonts and MPL-2.0. The exceptions are listed with their reasons: libvips, under LGPL-3.0, is loaded as a separate, replaceable library. FBX2glTF statically links the Autodesk FBX SDK; the product owner accepted that licence on 2 Nov 2026 (C-3).

## Uploads (NFR-14)

These checks run before a model is published, in this order:
- **Unpacking:** archives are unpacked with guards against zip slip and zip bombs. Counts and sizes are measured while inflating.
- **Virus scan:** each file is scanned by ClamAV when `CLAMDSCAN` is set. Without it, the upload report says the files were not scanned.
- **Validation:** glTF and 3D Tiles are checked in a separate process, with a time limit.
- **Conversion:** FBX is converted by FBX2glTF in its own process, with a time limit.
- **Tiling and optimising** a large or single GLB run in their own process too.

With the conversion sandbox on, each of the last three runs in a container with no network (below).

The browser never parses FBX itself.

The server runs as the unprivileged user `viewer` under systemd hardening:
- It can't gain privileges. It can't create namespaces either, unless the conversion sandbox is on (below), which needs them.
- It sees a read-only system and no home folders, and writes only to `/var/lib/viewer` and `/var/log/viewer`.
- Its sockets are limited to IP and Unix.

### Conversion sandbox

Each step that reads an uploaded file beyond its header runs in a container of its own (`CONVERT_SANDBOX=podman`, which `install.sh` sets when podman is installed):
- FBX conversion, both validators, tiling and optimising each get a new rootless Podman container, removed when the step ends.
- **No network:** `--network=none`, so the container has only a loopback interface. No address outside it is even routable, and no name can be looked up.
- **Read-only root** with nothing but the C libraries Node.js and FBX2glTF load (`sandbox/rootfs` in the bundle: no shell, no tools). The program is mounted read-only.
- **One writable folder:** that upload's own work folder, plus a small `/tmp`. It cannot see the library, other uploads, the settings or the database.
- No capabilities, no new privileges, no core dumps, and a time limit (30 minutes, 2 hours for tiling). It runs as the server's own unprivileged user.

The server checks this when it starts: a probe step must find no route to 192.0.2.1, no name lookup and a read-only root. If any of these fails, the server does not start (exit 78) and says why. Without podman the steps run in child processes, and the server log says so.

To let rootless podman make namespaces, `install.sh` adds a drop-in that lifts `RestrictNamespaces` for the server's service, only when the sandbox is on.

**Evidence:**
- the hostile-file tests in `apps/server/src/ingest.test.ts` and `validate.test.ts` (zip bomb, path traversal, damaged files; CI job `check`);
- `apps/server/src/sandbox.e2e.test.ts` (CI job `check`, rootless podman as the runner's user): the probe, a real FBX converted, validated and optimised in containers, a large model tiled with progress, and a step stopped at its time limit with no container left;
- `scripts/check-server-install.sh` (CI job `server-install`): on the installed system, the sandbox is on, the server checked it at start, and an FBX uploaded over HTTPS is converted and published through it.

## Audit (NFR-11)

Every action is logged with the workstation, address and time. The log is a hash chain that refuses changes: the admin page shows the first entry that does not match its hash. It can be sent to the SIEM as CEF (`AUDIT_SYSLOG`). See [OPERATIONS.md](./OPERATIONS.md).

## Left to the organisation

The penetration test and the accreditation decision are made by the organisation's own security team, against an installed system.
