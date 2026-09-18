import "server-only";

type Level = "debug" | "info" | "warn" | "error";
type Fields = Record<string, unknown>;

const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;
// Keys whose values never belong in logs, whatever they contain.
const SECRET_KEY_RE = /(secret|password|token|api[_-]?key|authorization|cookie|signature)/i;
const MAX_STRING = 500;

/** Redact secrets and mask emails. Billing rows and file contents must never be passed in. */
export function redact(value: unknown, key = "", depth = 0): unknown {
  if (SECRET_KEY_RE.test(key)) return "[redacted]";
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") {
    const masked = value.replace(EMAIL_RE, "$1***@$2");
    return masked.length > MAX_STRING ? `${masked.slice(0, MAX_STRING)}…` : masked;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, key, depth + 1));
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, "", depth + 1) };
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Fields).map(([k, v]) => [k, redact(v, k, depth + 1)]),
    );
  }
  return value;
}

function emit(level: Level, event: string, fields: Fields = {}): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    service: "web",
    event,
    ...(redact(fields) as Fields),
  });
  if (level === "error" || level === "warn") console.error(line);
  else console.log(line);
}

export const log = {
  debug: (event: string, fields?: Fields) => emit("debug", event, fields),
  info: (event: string, fields?: Fields) => emit("info", event, fields),
  warn: (event: string, fields?: Fields) => emit("warn", event, fields),
  error: (event: string, fields?: Fields) => emit("error", event, fields),
};
