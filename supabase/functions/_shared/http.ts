const origins = new Set([
  "https://orangepeelr.github.io",
  "http://localhost:5500",
  "http://127.0.0.1:5500",
  "http://localhost:3000",
]);

export function corsHeaders(req: Request): HeadersInit {
  const origin = req.headers.get("origin");
  return {
    ...(origin && origins.has(origin) ? { "Access-Control-Allow-Origin": origin } : {}),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  // Bound streamed bytes as well as Content-Length, which callers can omit.
  const reader = req.body?.getReader();
  if (!reader) throw new HttpError(400, "A JSON request body is required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 200_000) {
      await reader.cancel();
      throw new HttpError(413, "Request is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new HttpError(400, "Request body must be a JSON object."); }
}

export function questionFrom(body: Record<string, unknown>): string {
  if (typeof body.question !== "string" || !body.question.trim() || body.question.length > 2000) {
    throw new HttpError(400, "Enter a question between 1 and 2,000 characters.");
  }
  return body.question.trim();
}

export function handler(run: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin");
    if (origin && !origins.has(origin)) return json(req, { error: "Origin is not allowed." }, 403);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
    if (req.method !== "POST") return json(req, { error: "Use POST." }, 405);
    try { return await run(req); }
    catch (error) {
      if (error instanceof HttpError) return json(req, { error: error.message }, error.status);
      // Never return upstream errors, request headers, or secrets to the browser.
      console.error("Request failed", error instanceof Error ? error.name : "UnknownError");
      return json(req, { error: "The service is temporarily unavailable. Please try again." }, 503);
    }
  };
}
