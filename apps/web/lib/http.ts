import "server-only";

import { NextResponse } from "next/server";

export function newRequestId(): string {
  return crypto.randomUUID();
}

/** Generic user-facing error; details go to the logs under the same request id. */
export function errorResponse(
  status: number,
  requestId: string,
  message = "Something went wrong. Please try again.",
): NextResponse {
  return NextResponse.json(
    { error: message, requestId },
    { status, headers: { "x-request-id": requestId } },
  );
}

/** Read a JSON body with a hard size cap. Returns undefined for oversized or malformed bodies. */
export async function readJsonBody(request: Request, maxBytes: number): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return undefined;
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
