import { unzipSync } from "fflate";

/** A file the user dropped or picked, with its path inside the dropped folder or zip. */
export interface LocalFile {
  path: string;
  size: number;
  bytes(): Promise<Uint8Array>;
  /** Reads part of the file without loading all of it (uploads in chunks). */
  slice?(start: number, end: number): Promise<Uint8Array>;
}

export function fromBytes(path: string, data: Uint8Array): LocalFile {
  return { path, size: data.byteLength, bytes: async () => data };
}

export const ext = (p: string): string => (/\.([^./]+)$/.exec(p)?.[1] ?? "").toLowerCase();
export const dirOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/") + 1) : "");
export const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/** Resolves a relative URI from a file inside the set. Returns null for absolute or data URIs. */
export function resolvePath(fromFile: string, uri: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(uri) || uri.startsWith("/")) return null;
  let rel = uri.split(/[?#]/)[0]!;
  try {
    rel = decodeURIComponent(rel);
  } catch {
    /* keep it as written */
  }
  const out: string[] = [];
  for (const part of (dirOf(fromFile) + rel).split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

/** Unpacks every .zip in the set and drops a single shared top folder. */
export async function expandFiles(files: LocalFile[]): Promise<LocalFile[]> {
  const out: LocalFile[] = [];
  for (const f of files) {
    if (ext(f.path) !== "zip") {
      out.push(f);
      continue;
    }
    let entries: Record<string, Uint8Array>;
    try {
      entries = unzipSync(await f.bytes());
    } catch {
      throw new LoadError(`${f.path} is not a readable zip file.`);
    }
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith("/") || name.startsWith("__MACOSX/")) continue;
      out.push(fromBytes(name, data));
    }
  }
  const tops = new Set(out.map((f) => (f.path.includes("/") ? f.path.split("/")[0] : "")));
  if (tops.size === 1 && !tops.has("")) {
    const top = [...tops][0]! + "/";
    return out.map((f) => ({ ...f, path: f.path.slice(top.length) }));
  }
  return out;
}

export class LoadError extends Error {
  override name = "LoadError";
}

export class FileSet {
  private byPath = new Map<string, LocalFile>();
  private lower = new Map<string, LocalFile>();
  constructor(readonly files: LocalFile[]) {
    for (const f of files) {
      this.byPath.set(f.path, f);
      this.lower.set(f.path.toLowerCase(), f);
    }
  }
  get(path: string): LocalFile | undefined {
    return this.byPath.get(path) ?? this.lower.get(path.toLowerCase());
  }
  get bytes(): number {
    return this.files.reduce((s, f) => s + f.size, 0);
  }
}
