import os from "node:os";
import { describe, expect, it } from "vitest";
import { redactor } from "./redact.ts";

describe("debug log redaction", () => {
  const r = redactor(["/srv/acme-site/data", "AcmeSite"]);
  it("removes addresses, names, paths and settings", () => {
    const text = [
      `host ${os.hostname()} user ${os.userInfo().username}`,
      "connect to 10.20.30.40:5432 and fe80::1ff:fe23:4567:890a failed",
      "mac 00:1A:2B:3C:4D:5E",
      "fetch https://gis.intra.acme.co.il:8443/tiles?key=abc failed",
      "mail ops@acme.co.il, ssh lior@build-01",
      "server db01.corp.acme.local is down",
      "open /home/lior/projects/AcmeSite/WV3_P001_PAN.tif: no such file",
      "C:\\Users\\lior\\Desktop\\site\\view1.ntf",
      "\\\\fileserver\\share\\images\\a.tif",
      "HTTPS_PROXY=http://proxy.acme:3128 DATA_DIR=/srv/acme-site/data",
      "/srv/acme-site/data/work/train/splats.ply written",
    ].join("\n");
    const out = r(text);
    for (const bad of [os.hostname(), "10.20.30.40", "fe80::1ff", "00:1A:2B", "gis.intra", "acme", "Acme", "lior", "build-01", "db01", "WV3_P001", "fileserver", "proxy", "3128", "projects", "Users", "Desktop"]) expect(out).not.toContain(bad);
    expect(out).toContain("<ip>");
    expect(out).toContain("<mac>");
    expect(out).toContain("https://<host>/…");
    expect(out).toContain("<path>/<file>.tif");
    expect(out).toContain("<path>/splats.ply");
    expect(out).toContain("HTTPS_PROXY=<redacted>");
  });
  it("keeps what helps debugging", () => {
    const text = "COLMAP 4.2.1 on NVIDIA RTX A4000 (driver 550.54.15, CUDA 12.4): mapper took 1007 s; gsplat 1.4.0; torch.cuda.is_available() False; error: CUDA out of memory at step 12000";
    expect(r(text)).toBe(text);
  });
});
