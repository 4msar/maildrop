// localStorage helpers for per-browser conveniences. Storage can be unavailable (private
// mode, blocked site data), so every access is guarded and falls back to the default.

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Not persisted; the in-memory state still applies for this page.
  }
}
