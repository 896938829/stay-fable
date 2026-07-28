"use strict";

const KEY_PATTERN = /^[A-Za-z0-9._~-]{32,80}$/;

function bytesFrom(value) {
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return undefined;
}

function hex(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function cryptographicKey(wxApi) {
  const api = wxApi || globalThis.wx;
  if (api && typeof api.getRandomValues === "function") {
    return new Promise((resolve, reject) => {
      try {
        api.getRandomValues({
          length: 32,
          success(result) {
            const bytes = result && bytesFrom(result.randomValues);
            if (!bytes || bytes.length !== 32) {
              reject(new Error("Cryptographic randomness is unavailable"));
              return;
            }
            resolve(hex(bytes));
          },
          fail() {
            reject(new Error("Cryptographic randomness is unavailable"));
          },
        });
      } catch {
        reject(new Error("Cryptographic randomness is unavailable"));
      }
    });
  }

  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    const target = new Uint8Array(32);
    cryptoApi.getRandomValues(target);
    return hex(target);
  }
  throw new Error("Cryptographic randomness is unavailable");
}

function createIdempotencyManager(options) {
  const settings = options || {};
  const keys = new Map();

  function get(scope) {
    if (typeof scope !== "string" || scope.trim() === "") {
      throw new Error("Idempotency scope is required");
    }
    if (keys.has(scope)) {
      return keys.get(scope);
    }
    const generated =
      typeof settings.generator === "function"
        ? settings.generator(scope)
        : cryptographicKey(settings.wxApi);

    if (generated && typeof generated.then === "function") {
      const pending = Promise.resolve(generated)
        .then((key) => {
          if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
            throw new Error("Invalid idempotency key");
          }
          return key;
        })
        .catch((error) => {
          keys.delete(scope);
          throw error;
        });
      keys.set(scope, pending);
      return pending;
    }

    if (typeof generated !== "string" || !KEY_PATTERN.test(generated)) {
      throw new Error("Invalid idempotency key");
    }
    keys.set(scope, generated);
    return generated;
  }

  function clear(scope) {
    if (scope === undefined) {
      keys.clear();
    } else {
      keys.delete(scope);
    }
  }

  return { clear, get };
}

let defaultManager;

function getDefaultManager() {
  if (!defaultManager) {
    defaultManager = createIdempotencyManager();
  }
  return defaultManager;
}

module.exports = {
  clear(scope) {
    return getDefaultManager().clear(scope);
  },
  createIdempotencyManager,
  get(scope) {
    return getDefaultManager().get(scope);
  },
};
