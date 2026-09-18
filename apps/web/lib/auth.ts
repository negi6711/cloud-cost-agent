import "server-only";

import { authSchema } from "@cca/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { nextCookies } from "better-auth/next-js";
import { magicLink } from "better-auth/plugins";
import { sql } from "drizzle-orm";

import { identityDb } from "./db";
import { emailSender } from "./email";
import { serverEnv } from "./env";
import { log } from "./log";

export const MAGIC_LINK_TTL_SECONDS = 30 * 60;
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** A login link is only ever sent to an address that submitted the form, or to an admin. */
export async function mayReceiveLoginLink(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (serverEnv().ADMIN_EMAILS.includes(normalized)) return true;
  const result = await identityDb().execute<{ ok: boolean }>(sql`select lead_email_exists(${normalized}) as ok`);
  return result.rows[0]?.ok === true;
}

function createAuth() {
  const env = serverEnv();
  return betterAuth({
    appName: "Cloud Cost Decision Snapshot",
    baseURL: env.APP_BASE_URL,
    secret: env.AUTH_SECRET,
    database: drizzleAdapter(identityDb(), { provider: "pg", schema: authSchema }),
    emailAndPassword: { enabled: false },
    session: { expiresIn: SESSION_TTL_SECONDS },
    // Per-IP limits on sign-in and verification. Off only in automated tests, where every request
    // shares one IP; on for local development and every hosted environment.
    rateLimit: { enabled: env.APP_ENV !== "test" },
    plugins: [
      magicLink({
        expiresIn: MAGIC_LINK_TTL_SECONDS,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => {
          // Silently skip unknown addresses: the response never reveals whether an email is a lead,
          // and the endpoint cannot be used to send mail to arbitrary people.
          if (!(await mayReceiveLoginLink(email))) {
            log.info("auth.magic_link_suppressed");
            return;
          }
          await emailSender().send({
            to: email,
            subject: "Your Cloud Cost Decision Snapshot sign-in link",
            text: [
              "Use this link to sign in and view your Cloud Cost Decision Snapshot:",
              "",
              url,
              "",
              `The link works once and expires in ${MAGIC_LINK_TTL_SECONDS / 60} minutes.`,
              "If you did not request it, you can ignore this email.",
            ].join("\n"),
          });
        },
      }),
      nextCookies(), // must stay last
    ],
  });
}

type Auth = ReturnType<typeof createAuth>;
let cached: Auth | undefined;

/** Built lazily so `next build` never needs runtime secrets. */
export function getAuth(): Auth {
  cached ??= createAuth();
  return cached;
}
