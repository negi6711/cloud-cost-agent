import "server-only";

import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  assertValidKey,
  type ObjectInfo,
  ObjectTooLargeError,
  type PresignedUpload,
  type StorageAdapter,
  UPLOAD_CONTENT_TYPE,
} from "./types";

export interface R2Config {
  accountId: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  ttlSeconds: number;
}

/** Cloudflare R2 through its S3-compatible API. The bucket must be private (no public access). */
export class R2Storage implements StorageAdapter {
  private readonly client: S3Client;

  constructor(private readonly config: R2Config) {
    this.client = new S3Client({
      region: "auto",
      endpoint: `https://${config.accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  async presignUpload(key: string, contentLength: number): Promise<PresignedUpload> {
    assertValidKey(key);
    const command = new PutObjectCommand({
      Bucket: this.config.bucket,
      Key: key,
      ContentLength: contentLength,
      ContentType: UPLOAD_CONTENT_TYPE,
    });
    // Signing content-length means the upload fails unless it is exactly the declared size.
    const url = await getSignedUrl(this.client, command, {
      expiresIn: this.config.ttlSeconds,
      signableHeaders: new Set(["content-length", "content-type"]),
    });
    return {
      url,
      method: "PUT",
      headers: { "content-type": UPLOAD_CONTENT_TYPE },
      expiresAt: new Date(Date.now() + this.config.ttlSeconds * 1000).toISOString(),
    };
  }

  async head(key: string): Promise<ObjectInfo | null> {
    assertValidKey(key);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }));
      return { sizeBytes: res.ContentLength ?? 0 };
    } catch (error) {
      if (error instanceof NotFound || (error as { name?: string }).name === "NotFound") return null;
      throw error;
    }
  }

  async read(key: string, maxBytes: number): Promise<Buffer> {
    const info = await this.head(key);
    if (!info) throw new Error("object not found");
    if (info.sizeBytes > maxBytes) throw new ObjectTooLargeError();
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    if (!res.Body) throw new Error("empty object body");
    const bytes = await res.Body.transformToByteArray();
    if (bytes.byteLength > maxBytes) throw new ObjectTooLargeError();
    return Buffer.from(bytes);
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }
}
