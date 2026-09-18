/**
 * First-line content checks on an uploaded file. The file extension and the browser-declared type
 * are never trusted; only the bytes are. Deep parsing happens in the worker.
 */

export type SniffResult =
  | { ok: true; mimeType: "text/csv"; hasBom: boolean }
  | { ok: false; reason: SniffRejection };

export type SniffRejection =
  | "empty"
  | "binary_signature"
  | "nul_bytes"
  | "not_utf8"
  | "not_delimited_text";

const SIGNATURES: ReadonlyArray<readonly [string, readonly number[]]> = [
  ["zip/xlsx/docx", [0x50, 0x4b, 0x03, 0x04]],
  ["zip (empty)", [0x50, 0x4b, 0x05, 0x06]],
  ["pdf", [0x25, 0x50, 0x44, 0x46]],
  ["png", [0x89, 0x50, 0x4e, 0x47]],
  ["jpeg", [0xff, 0xd8, 0xff]],
  ["gif", [0x47, 0x49, 0x46, 0x38]],
  ["gzip", [0x1f, 0x8b]],
  ["ole/xls", [0xd0, 0xcf, 0x11, 0xe0]],
  ["parquet", [0x50, 0x41, 0x52, 0x31]],
  ["7z", [0x37, 0x7a, 0xbc, 0xaf]],
  ["rar", [0x52, 0x61, 0x72, 0x21]],
  ["utf16-le bom", [0xff, 0xfe]],
  ["utf16-be bom", [0xfe, 0xff]],
];

const UTF8_BOM = [0xef, 0xbb, 0xbf];
const DELIMITERS = [",", ";", "\t", "|"];

function startsWith(bytes: Uint8Array, sig: readonly number[]): boolean {
  return sig.length <= bytes.length && sig.every((b, i) => bytes[i] === b);
}

export function sniffUpload(bytes: Uint8Array): SniffResult {
  if (bytes.length === 0) return { ok: false, reason: "empty" };
  for (const [, sig] of SIGNATURES) {
    if (startsWith(bytes, sig)) return { ok: false, reason: "binary_signature" };
  }
  if (bytes.includes(0)) return { ok: false, reason: "nul_bytes" };

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, reason: "not_utf8" };
  }
  const hasBom = startsWith(bytes, UTF8_BOM);
  if (hasBom) text = text.slice(1);

  // A billing export has a header line with at least one supported delimiter.
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  if (!firstLine.trim() || !DELIMITERS.some((d) => firstLine.includes(d))) {
    return { ok: false, reason: "not_delimited_text" };
  }
  return { ok: true, mimeType: "text/csv", hasBom };
}

export const SNIFF_MESSAGES: Record<SniffRejection, string> = {
  empty: "The file is empty.",
  binary_signature:
    "This looks like a spreadsheet, archive, PDF or image, not a CSV. Export the AWS Cost Explorer data as CSV and upload that file.",
  nul_bytes: "The file contains binary data. Upload the CSV export from AWS Cost Explorer.",
  not_utf8: "The file is not UTF-8 text. Re-export it as a UTF-8 CSV from AWS Cost Explorer.",
  not_delimited_text:
    "The file does not look like a CSV: the first line has no comma, semicolon, tab or pipe separators.",
};
