import "server-only";

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { serverEnv } from "./env";
import { log } from "./log";

/** Emails carry links and status only, never billing rows (docs/product-spec.md §9 Email). */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export interface DevInboxEntry extends EmailMessage {
  id: string;
  sentAt: string;
}

/** Local development: writes each email as JSON so /dev/inbox can show it. Refused when hosted. */
class DevInboxSender implements EmailSender {
  constructor(private readonly dir: string) {}

  async send(message: EmailMessage): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const entry: DevInboxEntry = { ...message, id: crypto.randomUUID(), sentAt: new Date().toISOString() };
    await writeFile(path.join(this.dir, `${Date.now()}-${entry.id}.json`), JSON.stringify(entry, null, 2));
    log.info("email.dev_inbox", { subject: message.subject, to: message.to });
  }
}

/** Resend HTTP API. Without a verified domain Resend only delivers to the account owner's address. */
class ResendSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`email provider responded ${res.status}`);
    log.info("email.sent", { subject: message.subject, to: message.to });
  }
}

let cached: EmailSender | undefined;

export function emailSender(): EmailSender {
  if (!cached) {
    const env = serverEnv();
    cached =
      env.EMAIL_DRIVER === "resend"
        ? new ResendSender(env.RESEND_API_KEY!, env.EMAIL_FROM!)
        : new DevInboxSender(env.DEV_INBOX_DIR!);
  }
  return cached;
}

/** Newest first. Only meaningful for the dev-inbox driver. */
export async function readDevInbox(limit = 50): Promise<DevInboxEntry[]> {
  const env = serverEnv();
  if (env.EMAIL_DRIVER !== "dev-inbox" || !env.DEV_INBOX_DIR) return [];
  let files: string[];
  try {
    files = (await readdir(env.DEV_INBOX_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  files.sort().reverse();
  const entries = await Promise.all(
    files.slice(0, limit).map(async (f) => JSON.parse(await readFile(path.join(env.DEV_INBOX_DIR!, f), "utf8")) as DevInboxEntry),
  );
  return entries;
}

export function resetEmailForTests(): void {
  cached = undefined;
}
