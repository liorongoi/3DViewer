import type { LocalFile } from "@viewer/core";

const wrap = (file: File, path: string): LocalFile => ({ path, size: file.size, bytes: async () => new Uint8Array(await file.arrayBuffer()) });

/** Files from a file input; a folder pick keeps the paths inside the folder. */
export function fromInput(list: FileList | null): LocalFile[] {
  return [...(list ?? [])].map((f) => wrap(f, f.webkitRelativePath || f.name));
}

/** Files from a drop, walking any dropped folders. */
export async function fromDrop(dt: DataTransfer): Promise<LocalFile[]> {
  const entries = [...dt.items].map((i) => i.webkitGetAsEntry?.()).filter((e): e is FileSystemEntry => !!e);
  if (!entries.length) return [...dt.files].map((f) => wrap(f, f.name));
  const out: LocalFile[] = [];
  const walk = async (e: FileSystemEntry, prefix: string): Promise<void> => {
    if (e.isFile) {
      const f = await new Promise<File>((res, rej) => (e as FileSystemFileEntry).file(res, rej));
      out.push(wrap(f, prefix + e.name));
    } else if (e.isDirectory) {
      const reader = (e as FileSystemDirectoryEntry).createReader();
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const c of batch) await walk(c, `${prefix}${e.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, "");
  return out;
}

const STANDARD: [RegExp, string][] = [
  [/bldg|build|house|roof|wall|facade|בניין|מבנה/i, "Buildings"],
  [/tree|veg|plant|grass|bush|forest|צמח|עץ/i, "Vegetation"],
  [/road|street|bridge|rail|pole|pipe|fence|infra|כביש|גשר/i, "Infrastructure"],
  [/water|river|lake|sea|pool|מים|נחל/i, "Water"],
  [/terrain|ground|dtm|dem|surface|קרקע|שטח/i, "Terrain"],
];

/** Suggests a standard layer name for a node name (UPL-09). */
export function suggestLayer(name: string): string {
  return STANDARD.find(([re]) => re.test(name))?.[1] ?? "Other";
}
