import "server-only";

import { isAbsolute } from "node:path";

import { MAX_UPLOAD_BYTES } from "@cca/config";
import { z } from "zod";

const secret = (name: string) => z.string().min(32, `${name} must be at least 32 characters`);

const serverEnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    /** Deployment environment. NODE_ENV is "production" for any `next start`, even locally. */
    APP_ENV: z.enum(["development", "test", "staging", "production"]).default("development"),
    DATABASE_URL: z.url(),
    AUTH_SECRET: secret("AUTH_SECRET"),
    APP_BASE_URL: z.url().default("http://localhost:3000"),

    STORAGE_DRIVER: z.enum(["local", "r2"]).default("local"),
    LOCAL_STORAGE_DIR: z.string().optional(),
    STORAGE_URL_SIGNING_SECRET: secret("STORAGE_URL_SIGNING_SECRET"),
    R2_ACCOUNT_ID: z.string().optional(),
    R2_ACCESS_KEY_ID: z.string().optional(),
    R2_SECRET_ACCESS_KEY: z.string().optional(),
    R2_BUCKET: z.string().optional(),
    UPLOAD_MAX_BYTES: z.coerce.number().int().positive().max(MAX_UPLOAD_BYTES).default(MAX_UPLOAD_BYTES),
    SIGNED_URL_TTL_SECONDS: z.coerce.number().int().min(30).max(900).default(300),

    WORKER_URL: z.url().optional(),
    WORKER_SHARED_SECRET: secret("WORKER_SHARED_SECRET"),

    ADMIN_EMAILS: z
      .string()
      .default("")
      .transform((v) =>
        v
          .split(",")
          .map((e) => e.trim().toLowerCase())
          .filter(Boolean),
      ),
    EMAIL_DRIVER: z.enum(["dev-inbox", "resend"]).default("dev-inbox"),
    DEV_INBOX_DIR: z.string().optional(),
    RESEND_API_KEY: z.string().optional(),
    EMAIL_FROM: z.string().optional(),
  })
  .superRefine((env, ctx) => {
    if (env.STORAGE_DRIVER === "local") {
      if (!env.LOCAL_STORAGE_DIR || !isAbsolute(env.LOCAL_STORAGE_DIR)) {
        ctx.addIssue({ code: "custom", path: ["LOCAL_STORAGE_DIR"], message: "must be an absolute path" });
      }
      if (env.APP_ENV === "staging" || env.APP_ENV === "production") {
        ctx.addIssue({ code: "custom", path: ["STORAGE_DRIVER"], message: "local storage is not allowed when hosted" });
      }
    }
    const hosted = env.APP_ENV === "staging" || env.APP_ENV === "production";
    if (env.EMAIL_DRIVER === "dev-inbox") {
      if (hosted) {
        ctx.addIssue({ code: "custom", path: ["EMAIL_DRIVER"], message: "the dev inbox is not allowed when hosted" });
      }
      if (!env.DEV_INBOX_DIR || !isAbsolute(env.DEV_INBOX_DIR)) {
        ctx.addIssue({ code: "custom", path: ["DEV_INBOX_DIR"], message: "must be an absolute path" });
      }
    }
    if (env.EMAIL_DRIVER === "resend" && (!env.RESEND_API_KEY || !env.EMAIL_FROM)) {
      ctx.addIssue({ code: "custom", path: ["RESEND_API_KEY"], message: "RESEND_API_KEY and EMAIL_FROM are required" });
    }
    if (env.STORAGE_DRIVER === "r2") {
      for (const key of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"] as const) {
        if (!env[key]) ctx.addIssue({ code: "custom", path: [key], message: "required for r2 storage" });
      }
    }
  });

export type ServerEnv = z.infer<typeof serverEnvSchema>;

let cached: ServerEnv | undefined;

/** Parsed server environment. Read lazily so `next build` never needs runtime secrets. */
export function serverEnv(): ServerEnv {
  if (!cached) {
    const parsed = serverEnvSchema.safeParse(process.env);
    if (!parsed.success) {
      // Name the variables, never their values.
      const names = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      throw new Error(`Invalid server environment: ${names}`);
    }
    cached = parsed.data;
  }
  return cached;
}

/** Tests only: forget the cached environment after changing process.env. */
export function resetServerEnvForTests(): void {
  cached = undefined;
}
