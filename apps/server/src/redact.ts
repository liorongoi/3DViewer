import os from "node:os";

/**
 * Removes what could describe the network or the people around a server from text that leaves
 * it in a debug log (docs/OPERATIONS.md, "Debug log"). What stays: versions, hardware models,
 * timings, step names, error wording and file extensions. What goes, replaced by a placeholder:
 *
 *   machine and user names        <host>  <user>   (this machine's, and any user@host)
 *   IPv4 and IPv6 addresses       <ip>
 *   MAC addresses                 <mac>
 *   e-mail addresses              <email>
 *   URLs                          scheme://<host>/…  (host, port, path, query all removed)
 *   domain names                  <host>
 *   UNC shares (\\server\share)   <share>
 *   folder paths                  <path>/name.ext (only the last part, and only its extension
 *                                 when the name itself could say something)
 *   KEY=value for keys that look like settings (PROXY, HOST, URL, TOKEN, PASSWORD, …)  KEY=<redacted>
 *
 * It errs on the side of removing too much. Extra words to remove (configured paths, a site
 * name) can be passed in `known`.
 */

const TLD = "(?:com|net|org|io|gov|mil|edu|int|info|biz|co|il|uk|de|fr|eu|us|ru|cn|in|jp|local|lan|corp|internal|intra|intranet|home|localdomain|ad|domain|private|test|example|arpa)";

export function redactor(known: string[] = []) {
  const words = new Set<string>();
  const add = (w: string | undefined | null) => {
    if (w && w.trim().length >= 2) words.add(w.trim());
  };
  add(os.hostname());
  add(os.hostname().split(".")[0]);
  try {
    add(os.userInfo().username);
  } catch {
    /* no user name */
  }
  for (const k of known) add(k);
  // Longest first, so a full path goes before a part of it.
  const list = [...words].sort((a, b) => b.length - a.length);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  return (input: string): string => {
    let s = String(input);
    // Settings with values: KEY=value or KEY: value.
    s = s.replace(/\b([A-Z][A-Z0-9_]*(?:PROXY|HOST|HOSTNAME|URL|URI|DOMAIN|USER|USERNAME|PASS|PASSWORD|TOKEN|SECRET|KEY|DSN|ADDR|ADDRESS|SERVER|ORIGIN|ORIGINS|DIR|PATH|HOME)[A-Z0-9_]*)\s*([=:])\s*("[^"]*"|'[^']*'|\S+)/g, "$1$2<redacted>");
    s = s.replace(/\b(https?|ftp|wss?|s3|smb|nfs|postgres(?:ql)?|redis|mongodb):\/\/[^\s"'<>)]+/gi, "$1://<host>/…");
    s = s.replace(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, "<email>");
    s = s.replace(/\b[\w.-]+@[\w.-]+\b/g, "<user>@<host>");
    s = s.replace(/\\\\[^\\\s]+\\[^\s"']*/g, "<share>");
    // Paths: Windows (C:\a\b\name.ext) and POSIX (/a/b/name.ext, ~/a/name).
    s = s.replace(/\b[A-Za-z]:\\(?:[^\\\s"'<>|:*?]+\\)*([^\\\s"'<>|:*?]*)/g, (_, last: string) => `<path>/${safeName(last)}`);
    s = s.replace(/(^|[\s"'=(,:[])(~?\/(?:[^/\s"'<>()[\],:;]+\/)+([^/\s"'<>()[\],:;]*))/g, (_, pre: string, _p: string, last: string) => `${pre}<path>/${safeName(last)}`);
    s = s.replace(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, "<mac>");
    s = s.replace(/\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?::\d{1,5})?\b/g, "<ip>");
    // IPv6: hex groups with "::" or at least three colons (a clock time has two).
    s = s.replace(/(?<![\w:.])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?:%\w+)?(?![\w:])/gi, (m) => ((m.includes("::") || (m.match(/:/g) ?? []).length >= 3) && /[0-9a-f]/i.test(m) ? "<ip>" : m));
    s = s.replace(new RegExp(`\\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+${TLD}\\b`, "gi"), "<host>");
    // Whole words only, so a short machine name does not eat parts of other words.
    for (const w of list) s = s.replace(new RegExp(`(?<![A-Za-z0-9])${escape(w)}(?![A-Za-z0-9])`, "gi"), w === os.hostname() || w === os.hostname().split(".")[0] ? "<host>" : "<redacted>");
    return s;
  };
}

/** A file name that may say something (a site, a customer) becomes its kind; plain tool names stay. */
function safeName(name: string): string {
  if (!name) return "";
  const ext = /\.[A-Za-z0-9]{1,6}$/.exec(name)?.[0] ?? "";
  const stem = ext ? name.slice(0, -ext.length) : name;
  // Generic names that say nothing about where they are: keep them, they help debugging.
  if (/^(splats|provenance|georef|tileset|colmap|database|cameras|images|points3D|frames?_?\d*|k_\d+|select|blur|work|train|output|input|data|sparse|dense|python3?|ffmpeg|colmap|glomap|brush_app|opensplat|node|holo-splat-worker|sfm_pycolmap|simple_trainer(_2dgs)?|train)$/i.test(stem)) return name;
  return `<file>${ext}`;
}
