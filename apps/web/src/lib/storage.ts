/** Per-browser preferences only (language). Storage can be missing or throw: never rely on it. */
export function readPref(key: string): string | null {
  try {
    return globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writePref(key: string, value: string): void {
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    // private mode or blocked storage: the preference lasts for this visit only
  }
}
