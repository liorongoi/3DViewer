// Per-workstation preferences (UI spec §5.2). Storage can be unavailable; never throw.
export function readPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(`viewer.${key}`) as T | null) ?? fallback;
  } catch {
    return fallback;
  }
}
export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(`viewer.${key}`, value);
  } catch {
    /* ignore */
  }
}
