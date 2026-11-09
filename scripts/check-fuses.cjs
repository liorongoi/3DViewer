// WP 5.5: the packaged VIEWER.exe has its Electron fuses set as electron-builder.config.cjs asks.
//   node scripts/check-fuses.cjs apps/desktop/release/win-unpacked/VIEWER.exe
const path = require("node:path");
const { getCurrentFuseWire, FuseV1Options } = require(path.join(__dirname, "../apps/desktop/node_modules/@electron/fuses"));

const WANT = {
  RunAsNode: false,
  EnableCookieEncryption: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
  EnableEmbeddedAsarIntegrityValidation: true,
  OnlyLoadAppFromAsar: true,
  GrantFileProtocolExtraPrivileges: false,
};

(async () => {
  const wire = await getCurrentFuseWire(process.argv[2]);
  let failed = 0;
  for (const [name, want] of Object.entries(WANT)) {
    // Each fuse is the character "1" (on) or "0" (off).
    const got = wire[FuseV1Options[name]] === "1".charCodeAt(0);
    console.log(`${got === want ? "PASS" : "FAIL"} fuse ${name} is ${want ? "on" : "off"}`);
    if (got !== want) failed++;
  }
  process.exit(failed ? 1 : 0);
})();
