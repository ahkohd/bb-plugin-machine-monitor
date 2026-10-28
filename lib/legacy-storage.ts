const LEGACY_PREFIXES = ["beacon:", "machine-status:"];
const CURRENT_PREFIX = "machine-monitor:";

export function moveLegacyStorage(storage: Storage): void {
  try {
    const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
    for (const legacyKey of keys) {
      const prefix = LEGACY_PREFIXES.find((candidate) => legacyKey?.startsWith(candidate));
      if (!legacyKey || !prefix) continue;
      const value = storage.getItem(legacyKey);
      const currentKey = CURRENT_PREFIX + legacyKey.slice(prefix.length);
      if (value !== null && storage.getItem(currentKey) === null) storage.setItem(currentKey, value);
      storage.removeItem(legacyKey);
    }
  } catch {
    return;
  }
}
