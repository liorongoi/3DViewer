# WP 0.6 Desktop shell spike — first round

*2 Nov 2026. Code: [`apps/desktop`](../../apps/desktop). Gate G0 needs the second round on the reference Windows workstation.*

## Built

- **Electron 45.0.0** shell that loads the unchanged web build from a private `viewer-app://` origin.
- **`viewer-file://`** protocol: the user opens a folder; the page gets a base URL with a random id, never the real path. Files stream from disk with **HTTP range requests** (206, `Content-Range`, 416 past the end), so a 50 GB tileset is read piece by piece.
- **Sandbox:** only folders the user opened are reachable. `../`, encoded `%2e%2e`, `..%2F` and symlinks pointing outside all answer 404. Seven unit tests cover ranges and escapes.
- **Hardening** (plan 3.2): context isolation, renderer sandbox, no Node integration, narrow preload API, no pop-up windows, no navigation away from the app, all permission prompts denied.
- **Air gap:** every request that is not `viewer-app:`, `viewer-file:`, `data:` or `blob:` is cancelled in the main process, and the CSP says the same.

## Measured (Linux build machine, software WebGL, no GPU)

| Check | Result |
|---|---|
| App opens, full UI renders | Yes (same build as the web portal) |
| Range request on a local `tileset.json` | `206 bytes 0-15/40653` |
| Escape attempt `..%2F..%2F..%2Fetc%2Fpasswd` | 404 |
| Request to `https://example.com` from the page | Blocked |
| Preload API visible in the page | `viewerDesktop.openFolder` present |
| Lyon 3D Tiles streamed through `viewer-file://` | 54 tiles loaded |
| First view, frame rate | Not meaningful here (software rendering at ~1 fps); measured in round 2 |

## Issues found and fixed

- The page was refused when the URL had a query string, because the content type was guessed from the full URL. Types now come from the file extension of the path.
- The web build's own CSP blocked `viewer-file:`; it now allows it for connections and images.
- Cesium needs `'unsafe-eval'` (as the web build already allows); the desktop CSP matches the web one.

## Round 2 (reference workstation)

1. Windows 10 and 11 locked-down image, per-user install with network off (electron-builder NSIS, WP 5.5).
2. A 50 GB local tileset: first view ≤ 3 s, ≥ 60 fps average on the RTX A4000 (D-4 gate).
3. Antivirus scanning cost on many small tile files; if high, read tiles from a single pack file instead.
