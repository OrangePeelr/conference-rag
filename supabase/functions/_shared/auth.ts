import { HttpError } from "./http.ts";

export async function authenticate(req: Request): Promise<HeadersInit> {
  const authorization = req.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) throw new HttpError(401, "Please sign in first.");
  const headers = {
    Authorization: authorization,
    apikey: Deno.env.get("SUPABASE_ANON_KEY")!,
    "Content-Type": "application/json",
  };
  // Verify the token against Auth; decoding a JWT alone does not validate it.
  const result = await fetch(`${Deno.env.get("SUPABASE_URL")}/auth/v1/user`, {
    headers, signal: AbortSignal.timeout(10_000),
  });
  if (!result.ok) throw new HttpError(401, "Your session has expired. Please sign in again.");
  const user = await result.json();
  if (!user.id) throw new HttpError(401, "Please sign in first.");
  return headers;
}

export async function consumeQuota(headers: HeadersInit): Promise<void> {
  const result = await fetch(`${Deno.env.get("SUPABASE_URL")}/rest/v1/rpc/consume_ai_quota`, {
    method: "POST", headers, body: "{}", signal: AbortSignal.timeout(10_000),
  });
  if (!result.ok) throw new HttpError(503, "Unable to check usage. Please try again.");
  if (!(await result.json())) throw new HttpError(429, "Too many requests. Please try again in a minute.");
}
