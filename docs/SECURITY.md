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

Operating-system packages that the server uses are not in it. These are PostgreSQL, ClamAV and Chromium (for thumbnails). They come from the operating system's own package inventory.

`THIRD_PARTY_LICENSES.md` lists every shipped package with its licence text. Both the SBOM and the licence report fail the build on a licence outside the allowed list in `scripts/licenses.cjs`. That list has permissive licences, OFL for fonts and MPL-2.0. The exceptions are listed with their reasons: libvips, under LGPL-3.0, is loaded as a separate, replaceable library. FBX2glTF statically links the Autodesk FBX SDK; the product owner accepted that licence on 2 Nov 2026 (C-3).

## Uploads (NFR-14)

These checks run before a model is published, in this order:
- **Unpacking:** archives are unpacked with guards against zip slip and zip bombs. Counts and sizes are measured while inflating.
- **Virus scan:** each file is scanned by ClamAV when `CLAMDSCAN` is set. Without it, the upload report says the files were not scanned.
- **Validation:** glTF and 3D Tiles are checked in a separate Node process, with a time limit.
- **Conversion:** FBX is converted by FBX2glTF in its own process, with a time limit.

The browser never parses FBX itself.

The server runs as the unprivileged user `viewer` under systemd hardening:
- It can't gain privileges or create namespaces.
- It sees a read-only system and no home folders, and writes only to `/var/lib/viewer` and `/var/log/viewer`.
- Its sockets are limited to IP and Unix.

The plan's further step, each conversion job in a container with no network (rootless Podman, `--network=none`), is not built yet.

**Evidence:** the hostile-file tests in `apps/server/src/ingest.test.ts` and `validate.test.ts` (zip bomb, path traversal, damaged files; CI job `check`).

## Audit (NFR-11)

Every action is logged with the workstation, address and time. The log is a hash chain that refuses changes: the admin page shows the first entry that does not match its hash. It can be sent to the SIEM as CEF (`AUDIT_SYSLOG`). See [OPERATIONS.md](./OPERATIONS.md).

## Left to the organisation

The penetration test and the accreditation decision are made by the organisation's own security team, against an installed system.
