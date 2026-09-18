import "server-only";

import { mkdir, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";

import { signToken, verifyToken } from "../signing";
import {
  assertValidKey,
  type ObjectInfo,
  ObjectTooLargeError,
  type PresignedUpload,
  type StorageAdapter,
  UPLOAD_CONTENT_TYPE,
} from "./types";

export const LOCAL_PUT_PURPOSE = "local-storage-put/v1";

export interface LocalPutGrant {
  key: string;
  contentLength: number;
}

/**
 * Filesystem storage for local development and tests. Presigned uploads go to the same-origin
 * route /api/dev-storage/upload, authorized by an HMAC token that binds key, size and expiry, the
 * same guarantees an R2 presigned URL gives.
 */
export class LocalStorage implements StorageAdapter {
  constructor(
    private readonly root: string,
    private readonly signingSecret: string,
    private readonly ttlSeconds: number,
  ) {}

  /** Absolute path for a key; throws unless the key has our shape and stays under root. */
  pathFor(key: string): string {
    assertValidKey(key);
    const root = path.resolve(this.root);
    const full = path.resolve(root, ...key.split("/"));
    if (!full.startsWith(root + path.sep)) throw new Error("invalid storage key");
    return full;
  }

  async presignUpload(key: string, contentLength: number): Promise<PresignedUpload> {
    assertValidKey(key);
    const token = signToken<LocalPutGrant>(
      this.signingSecret,
      LOCAL_PUT_PURPOSE,
      { key, contentLength },
      this.ttlSeconds,
    );
    return {
      url: `/api/dev-storage/upload?token=${encodeURIComponent(token)}`,
      method: "PUT",
      headers: { "content-type": UPLOAD_CONTENT_TYPE },
      expiresAt: new Date(Date.now() + this.ttlSeconds * 1000).toISOString(),
    };
  }

  verifyPutToken(token: string | null): LocalPutGrant | null {
    const grant = verifyToken<LocalPutGrant>(this.signingSecret, LOCAL_PUT_PURPOSE, token);
    if (!grant || typeof grant.key !== "string" || typeof grant.contentLength !== "number") return null;
    try {
      assertValidKey(grant.key);
    } catch {
      return null;
    }
    return grant;
  }

  async ensureParent(key: string): Promise<string> {
    const full = this.pathFor(key);
    await mkdir(path.dirname(full), { recursive: true });
    return full;
  }

  async head(key: string): Promise<ObjectInfo | null> {
    try {
      const s = await stat(this.pathFor(key));
      return s.isFile() ? { sizeBytes: s.size } : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async read(key: string, maxBytes: number): Promise<Buffer> {
    const info = await this.head(key);
    if (!info) throw new Error("object not found");
    if (info.sizeBytes > maxBytes) throw new ObjectTooLargeError();
    return readFile(this.pathFor(key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}
