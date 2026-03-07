const CHROME_STORE_PREFIX = "gsm.chrome";

function toStorageKey(key: string): string {
  return `${CHROME_STORE_PREFIX}.${key}`;
}

function getStorage(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch (error) {
    console.error("Unable to access local storage:", error);
    return null;
  }
}

export function getChromeStoreValue(key: string): string | null {
  const storage = getStorage();
  if (!storage) {
    return null;
  }

  try {
    return storage.getItem(toStorageKey(key));
  } catch (error) {
    console.error(`Unable to read local storage key: ${key}`, error);
    return null;
  }
}

export function setChromeStoreValue(key: string, value: string): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(toStorageKey(key), value);
  } catch (error) {
    console.error(`Unable to write local storage key: ${key}`, error);
  }
}

export function getChromeStoreBoolean(key: string, fallback: boolean): boolean {
  const value = getChromeStoreValue(key);
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  return fallback;
}

export function setChromeStoreBoolean(key: string, value: boolean): void {
  setChromeStoreValue(key, value ? "true" : "false");
}
