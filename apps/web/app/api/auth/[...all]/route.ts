import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "@/lib/auth";

// Resolved per request so the build never constructs the auth instance (it needs runtime secrets).
export async function GET(request: Request): Promise<Response> {
  return toNextJsHandler(getAuth()).GET(request);
}

export async function POST(request: Request): Promise<Response> {
  return toNextJsHandler(getAuth()).POST(request);
}
