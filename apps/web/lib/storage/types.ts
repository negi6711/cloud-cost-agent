export interface PresignedUpload {
  /** Absolute URL for R2; same-origin path for the local driver. */
  url: string;
  method: "PUT";
  /** Headers the browser must send exactly (they are part of the signature). */
  headers: Record<string, string>;
  expiresAt: string;
}

export interface ObjectInfo {
  sizeBytes: number;
}

/** Private object storage. Keys are always generated server-side (see `newUploadKey`). */
export interface StorageAdapter {
  presignUpload(key: string, contentLength: number): Promise<PresignedUpload>;
  head(key: string): Promise<ObjectInfo | null>;
  /** Read a whole object; refuses objects larger than `maxBytes`. */
  read(key: string, maxBytes: number): Promise<Buffer>;
  delete(key: string): Promise<void>;
}

/** Uploads are always sent with this type; the real type is determined by sniffing the bytes. */
export const UPLOAD_CONTENT_TYPE = "application/octet-stream";

const KEY_RE = /^uploads\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function newUploadKey(tenantId: string): string {
  const key = `uploads/${tenantId}/${crypto.randomUUID()}`;
  assertValidKey(key);
  return key;
}

/** Defense in depth against path traversal: only keys of our own shape are ever accepted. */
export function assertValidKey(key: string): void {
  if (!KEY_RE.test(key)) throw new Error("invalid storage key");
}

export function keyBelongsToTenant(key: string, tenantId: string): boolean {
  return KEY_RE.test(key) && key.startsWith(`uploads/${tenantId}/`);
}

export class ObjectTooLargeError extends Error {
  constructor() {
    super("object exceeds the allowed size");
    this.name = "ObjectTooLargeError";
  }
}
