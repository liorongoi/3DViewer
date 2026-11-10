# HOLO desktop (Electron)

The Windows EXE wraps the same web build as the portal (plan 3.2, WP 5.1). It opens models from the computer, streams big local 3D Tiles from disk (WP 5.3), and uses the library server when IT has configured one and it answers (WP 5.4).

```sh
pnpm --filter @viewer/web build            # the page the shell loads
node apps/desktop/node_modules/electron/install.js   # once: fetch the Electron binary (pnpm skips install scripts)
pnpm --filter @viewer/desktop start
```

## Library server address

IT sets it once per machine, by whichever fits their tooling; the first one found wins:

1. `VIEWER_SERVER_URL` in the environment (testing, or a launcher script);
2. `viewer.json` next to `HOLO.exe`: `{"serverUrl": "https://viewer.internal"}` (the installer writes it when given `SERVER_URL=…`);
3. `%ProgramData%\VIEWER\viewer.json`, the same file for every user of the machine;
4. the registry value `ServerUrl` under `HKLM\Software\VIEWER`, then `HKCU\Software\VIEWER` (Group Policy).

Only `http` and `https` addresses without a user name, query or fragment are taken; anything else is skipped and reported (`viewerDesktop.info().problems`). With no address the app works on local files only and shows no server status.

The page never talks to the server directly. It uses `viewer-server://library/…`, which the main process forwards to the configured address: method, body and headers go through (ranges, tus upload offsets, the admin's token), cookies do not, and a redirect may only stay on the same server. The bridge answers the browser's cross-origin checks itself, so the server stays same-origin only and needs no `CORS_ORIGINS` for the app.

While the server answers, the library is the server's and the status pill says **Server online**; when it stops answering the pill says **Offline**, local files still open, and the app checks again every 10 s (every 30 s while online). It switches back by itself, with no restart.

## Local files

- **Open:** the upload wizard's *Choose files* and *Choose folder* use the system dialogs; a file or folder dropped anywhere on the window opens the wizard; files passed on the command line (Explorer's *Open with*, a file association: `.glb`, `.gltf`, `.fbx`, `.zip`, `tileset.json`) wait for the page, and a second start hands its files to the running window.
- **In place:** each file is served at `viewer-file://<random id>/<path>` with HTTP range requests and loaded from there, never copied into memory, so a 50 GB tileset streams piece by piece. A `.gltf` or `tileset.json` opened on its own brings its folder with it (its buffers, textures and tiles); any other file opened on its own makes only that file reachable.
- **Keep on this computer only:** with the server online the wizard can still open a model locally without sending it; files opened from Explorer or a drop start with that ticked.
- **FBX (WP 5.2):** an FBX the user opened is converted to GLB on this computer with FBX2glTF 0.9.7, the converter the server uses (decision D-3), so it opens offline and looks as it will once published. If it is sent to the server, the original FBX goes, and the server converts it again and keeps it. The converter runs on its own: no shell, an empty work folder of its own (under the temp folder, cleared at start and quit) as its current and temp folder, none of the user's environment, at most 10 minutes, one at a time, killed when the app quits. Only a file the user opened can be converted; the page cannot name a path. The program comes from the `fbx2gltf` npm package in development and from `resources/bin` once installed (`VIEWER_FBX2GLTF` overrides both). It contains the Autodesk FBX SDK, whose licence the product owner accepted (risk R-02).
- **Sandboxed:** only what the user opened is reachable. Paths outside it, `..` tricks and symlinks that leave it answer 404 (`src/local-files.test.ts`). A dropped file's path is read by the preload from the real `File`; the page cannot name a path itself.

## Installer (WP 5.5)

`pnpm --filter @viewer/desktop dist` (on Windows; after building the web app and the desktop app) makes `release/HOLO-Setup-<version>.exe`, an NSIS installer from `electron-builder.config.cjs`:

- **Per user, no administrator:** it installs to `%LOCALAPPDATA%\Programs\HOLO` and writes only under HKCU; nothing goes to Program Files or HKLM. The user may choose another folder.
- **Silent install for IT:** `HOLO-Setup-<version>.exe /S /SERVER_URL=https://viewer.internal` writes the address to `viewer.json` next to `HOLO.exe`. Without it, IT can still set the address machine-wide by `%ProgramData%\VIEWER\viewer.json` or the `ServerUrl` registry value (Group Policy); see *Library server address* above. Uninstall: `"Uninstall HOLO.exe" /S`.
- **Files:** `.glb` and `.gltf` open with HOLO; `.fbx`, `.zip` and `.json` (tileset.json) only offer *Open with HOLO*, so it never takes over files other programs own.
- **Contents:** the app in an archive checked at start, the web build under `resources\web` (without the FBX test file), FBX2glTF under `resources\bin`, and `THIRD_PARTY_LICENSES.md`.
- **Hardened binary:** Electron fuses switched off running as plain Node, `NODE_OPTIONS`, the inspector from the command line and extra `file://` privileges, and on cookie encryption, archive integrity checks and loading the app only from its archive (`scripts/check-fuses.cjs`). An installed app also ignores the development switches (`VIEWER_SMOKE`, `VIEWER_WEB_DIR`, `VIEWER_QUERY`, `VIEWER_FBX2GLTF`).
- **Signing:** with `CSC_LINK` (the organisation's .pfx, or its base64) and `CSC_KEY_PASSWORD` the app and installer are signed (SHA-256, timestamped at `VIEWER_TIMESTAMP_URL` when set); without them they are built unsigned and the build says so. `VIEWER_VERSION` sets the version.
- **CI:** the `desktop-installer` job builds it on Windows, checks the fuses, installs it silently as the runner's user with a server address, checks every point above, starts it, uninstalls it and checks nothing is left (`scripts/check-installer.ps1`). The installer is kept as a download for 14 days.

Building on Linux needs Wine for the NSIS step; `pnpm --filter @viewer/desktop dist:dir` gives the unpacked app without it.

## Hardening

Context isolation, sandbox, no Node in the page, a narrow preload API (`viewerDesktop.info / openFiles / openFolder / openDropped / takeOpened / onOpened / platform`), no new windows, no navigation away, every permission request refused. Air gap: the session cancels any request that is not `viewer-app:`, `viewer-file:`, `viewer-server:`, `data:` or `blob:`, and the security policy repeats it; the page cannot reach the server's address directly either.

## Checks

```sh
pnpm --filter @viewer/desktop test                    # address sources, the bridge, the file sandbox
xvfb-run -a node scripts/check-desktop.cjs            # the built app against the real server (build web, server and desktop first)
```

Smoke test with a big tileset (used on the build machine, which has no GPU):

```sh
VIEWER_QUERY="?test" VIEWER_SMOKE=/path/to/tileset-folder \
  xvfb-run electron --no-sandbox --ignore-gpu-blocklist --use-angle=swiftshader .
```
