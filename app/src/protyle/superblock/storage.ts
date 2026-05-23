// Storage capability helper. Pure + unit-tested. The runtime's "storage" cap
// persists JSON under /data/storage/superblock/<key>.json via the kernel file API,
// so values survive reloads and are shared across blocks (unlike "persist", which
// is per-block IAL). This sanitizes an arbitrary key into a safe file path.

const ROOT = "/data/storage/superblock/";

// Map any user key to a safe filename (no path traversal, no odd chars).
export const storageKey = (key: string): string =>
    String(key || "").trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120) || "_";

export const storagePath = (key: string): string => `${ROOT}${storageKey(key)}.json`;
