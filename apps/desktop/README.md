# VIEWER desktop (Electron)

The Windows EXE wraps the same web build as the portal (plan 3.2, WP 5.1). This folder is the **WP 0.6 spike**: the shell, the hardened window, and `viewer-file://` for streaming local 3D Tiles.

```sh
pnpm --filter @viewer/web build            # the page the shell loads
node node_modules/electron/install.js       # once: fetch the Electron binary (pnpm skips install scripts)
pnpm --filter @viewer/desktop start
```

Smoke test (used on the build machine, which has no GPU):

```sh
VIEWER_QUERY="?test" VIEWER_SMOKE=/path/to/tileset-folder \
  xvfb-run electron --no-sandbox --ignore-gpu-blocklist --use-angle=swiftshader . 
```

- `viewer-app://app/` serves the web build; `viewer-file://<id>/` serves a folder the user opened, with HTTP range requests. Paths outside the folder, `..` tricks and symlinks that leave it answer 404 (see `src/local-files.test.ts`).
- Context isolation, sandbox, no Node in the page, a two-item preload API (`viewerDesktop.openFolder`, `platform`), no new windows, no navigation away, every permission request refused.
- Air gap: the session cancels any request that is not `viewer-app:`, `viewer-file:`, `data:` or `blob:`; the CSP repeats it. The configured library server will be added to that list in WP 5.4.
