import "server-only";

import { serverEnv } from "../env";
import { LocalStorage } from "./local";
import { R2Storage } from "./r2";
import type { StorageAdapter } from "./types";

export * from "./types";

let cached: StorageAdapter | undefined;

export function storage(): StorageAdapter {
  if (!cached) {
    const env = serverEnv();
    cached =
      env.STORAGE_DRIVER === "r2"
        ? new R2Storage({
            accountId: env.R2_ACCOUNT_ID!,
            accessKeyId: env.R2_ACCESS_KEY_ID!,
            secretAccessKey: env.R2_SECRET_ACCESS_KEY!,
            bucket: env.R2_BUCKET!,
            ttlSeconds: env.SIGNED_URL_TTL_SECONDS,
          })
        : new LocalStorage(env.LOCAL_STORAGE_DIR!, env.STORAGE_URL_SIGNING_SECRET, env.SIGNED_URL_TTL_SECONDS);
  }
  return cached;
}

/** The local driver, or null when storage is hosted (the dev upload route is then disabled). */
export function localStorageOrNull(): LocalStorage | null {
  const s = storage();
  return s instanceof LocalStorage ? s : null;
}

export function resetStorageForTests(): void {
  cached = undefined;
}
