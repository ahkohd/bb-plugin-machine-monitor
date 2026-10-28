const LEGACY_PREFIX = "beacon:";
const CURRENT_PREFIX = "machine-status:";

export function moveLegacyStorage(storage: Storage): void {
  try {
    const legacyKeys = Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key): key is string => key?.startsWith(LEGACY_PREFIX) ?? false);
    for (const legacyKey of legacyKeys) {
      const value = storage.getItem(legacyKey);
      const currentKey = CURRENT_PREFIX + legacyKey.slice(LEGACY_PREFIX.length);
      if (value !== null && storage.getItem(currentKey) === null) storage.setItem(currentKey, value);
      storage.removeItem(legacyKey);
    }
  } catch {
    return;
  }
}
