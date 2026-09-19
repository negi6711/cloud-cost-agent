/** Display formatting for amounts that the worker stores as exact decimal strings. */

export function money(amount: string | null | undefined, currency: string | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  const value = Number(amount);
  if (currency && /^[A-Z]{3}$/.test(currency)) {
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
  }
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);
}

/**
 * "0.2955" -> "29.6%". Exact decimal arithmetic with round-half-up, matching the worker; floats
 * would print 29.5% because 0.2955 is 0.29549999... in binary.
 */
export function pct(ratio: string | null | undefined): string {
  const m = ratio ? /^(-?)(\d+)(?:\.(\d+))?$/.exec(ratio) : null;
  if (!m) return "—";
  const [, sign, whole, frac = ""] = m;
  // |ratio| x 1,000,000 as an exact integer (parsed from digits, never multiplied as a float).
  const millionths = Number.parseInt(whole! + (frac + "000000").slice(0, 6), 10);
  if (!Number.isSafeInteger(millionths)) return "—";
  const tenths = Math.floor(millionths / 1000) + (millionths % 1000 >= 500 ? 1 : 0);
  return `${tenths === 0 ? "" : sign}${Math.floor(tenths / 10)}.${tenths % 10}%`;
}

export function monthLabel(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  return new Date(Date.UTC(y!, (m ?? 1) - 1, 1)).toLocaleString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}
