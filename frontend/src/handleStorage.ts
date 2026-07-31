/**
 * Persistent storage for the Nox gateway's decryption material.
 *
 * WHY THIS FILE EXISTS
 *
 * Decrypting through the gateway needs a `DataAccessAuthorization` — an EIP-712
 * signature binding a freshly generated RSA public key to the user's address.
 * The SDK is well behaved about it: the authorization carries `expiresAt = now +
 * 3600`, and `decrypt()` reuses a stored one for that whole hour instead of
 * asking again. One signature per hour is the intended cost.
 *
 * The catch is where it stores it. `createHandleClient` never passes a
 * `storageService`, so `HandleClient` falls back to its default
 * `InMemoryStorageService` — a plain object on the instance. That dies on every
 * page reload, and again every time we rebuild the client (which we do whenever
 * the account changes). So the hour-long authorization never survived long
 * enough to be reused, and each decrypt raised its own MetaMask prompt. With a
 * position, a wrapper balance and a row of fills all resolving at once, that is
 * a queue of twenty-odd signature requests.
 *
 * Backing it with localStorage restores the behaviour the SDK already intended:
 * sign once, reuse for an hour, across reloads.
 *
 * WHAT IS BEING STORED
 *
 * The authorization and an RSA *private* key, both scoped to one address, chain
 * and gateway, and both expiring within the hour. They authorise reading values
 * this address is already entitled to read — they are not spending keys and
 * cannot move funds. This is the same trade every "sign in with Ethereum"
 * session makes. It is still real key material, so it is namespaced, it is
 * cleared on disconnect, and it is never sent anywhere except the gateway that
 * issued the challenge.
 */

const PREFIX = "nox:";

/** Matches the SDK's IStorageService, which the package does not export. */
export interface HandleStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * localStorage, with every call guarded.
 *
 * Storage throws rather than returns in two ordinary situations — Safari
 * private mode, and a full quota — and the SDK treats a throwing store as
 * "no material", which merely costs an extra signature. Swallowing is
 * therefore the correct failure mode: degraded, never broken.
 */
export const persistentHandleStorage: HandleStorage = {
  getItem(key) {
    try {
      return localStorage.getItem(PREFIX + key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(PREFIX + key, value);
    } catch {
      /* private mode or quota — the SDK just re-signs */
    }
  },
  removeItem(key) {
    try {
      localStorage.removeItem(PREFIX + key);
    } catch {
      /* nothing to do */
    }
  },
};

/**
 * Drops every stored authorization.
 *
 * Called on disconnect: leaving decryption material behind for an address the
 * user has just walked away from is exactly the stale-credential problem the
 * account-keyed handle client already guards against, one layer down.
 */
export function clearHandleStorage() {
  try {
    const doomed: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) doomed.push(k);
    }
    for (const k of doomed) localStorage.removeItem(k);
  } catch {
    /* nothing we can do, and nothing that breaks */
  }
}
