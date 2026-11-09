// Windows installer pipeline (WP 5.5): a per-user NSIS installer that needs no administrator,
// signed with the organisation's certificate when the pipeline has it.
//
//   pnpm --filter @viewer/web build && pnpm --filter @viewer/desktop build
//   pnpm --filter @viewer/desktop dist            (on Windows; on Linux it needs Wine for NSIS)
//
// Signing: set CSC_LINK (the .pfx file, or its base64) and CSC_KEY_PASSWORD; without them the
// installer is built unsigned and says so. VIEWER_VERSION sets the version (the release, WP 6.8).
// The library server address can be given at install time: VIEWER-Setup.exe /S /SERVER_URL=https://...
const path = require("node:path");

const fbx = path.dirname(require.resolve("fbx2gltf/package.json", { paths: [__dirname] }));

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "org.viewer.desktop",
  productName: "VIEWER",
  copyright: "VIEWER",
  extraMetadata: { name: "viewer", ...(process.env.VIEWER_VERSION ? { version: process.env.VIEWER_VERSION } : {}) },
  directories: { output: "release", buildResources: "build" },
  // The main process has no npm packages at run time: only its own build goes into the archive.
  files: ["dist/**/*", "!dist/**/*.test.*", "package.json", "!node_modules/**/*"],
  asar: true,
  extraResources: [
    // The FBX test file is for checks, not users.
    { from: "../web/dist", to: "web", filter: ["**/*", "!samples/fbx/**"] },
    { from: path.join(fbx, "bin/Windows_NT/FBX2glTF.exe"), to: "bin/FBX2glTF.exe" },
    { from: "../../THIRD_PARTY_LICENSES.md", to: "THIRD_PARTY_LICENSES.md" },
  ],
  // Hardening of the Electron binary itself: no running as plain Node, no Node options or
  // inspector from the command line or environment, the app only from its checked archive.
  electronFuses: {
    runAsNode: false,
    enableCookieEncryption: true,
    enableNodeOptionsEnvironmentVariable: false,
    enableNodeCliInspectArguments: false,
    enableEmbeddedAsarIntegrityValidation: true,
    onlyLoadAppFromAsar: true,
    grantFileProtocolExtraPrivileges: false,
  },
  win: {
    target: [{ target: "nsis", arch: ["x64"] }],
    executableName: "VIEWER",
    // glTF opens with VIEWER by default; FBX, zip and JSON (tileset.json) only appear under
    // "Open with", so the app never takes over files other programs own (build/installer.nsh).
    fileAssociations: [
      { ext: "glb", name: "glTF binary model", role: "Viewer" },
      { ext: "gltf", name: "glTF model", role: "Viewer" },
    ],
    signtoolOptions: { signingHashAlgorithms: ["sha256"], rfc3161TimeStampServer: process.env.VIEWER_TIMESTAMP_URL || undefined },
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowElevation: false,
    allowToChangeInstallationDirectory: true,
    selectPerMachineByDefault: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: "VIEWER",
    artifactName: "VIEWER-Setup-${version}.exe",
    include: "build/installer.nsh",
    deleteAppDataOnUninstall: false,
  },
};
