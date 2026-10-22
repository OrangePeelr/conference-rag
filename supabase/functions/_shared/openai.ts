import { HttpError } from "./http.ts";

export async function openai(path: string, body: unknown) {
  const routerKey = Deno.env.get("OPENROUTER_API_KEY");
  const key = routerKey || Deno.env.get("OPENAI_API_KEY");
  if (!key) throw new HttpError(503, "The AI service has not been configured.");
  const baseUrl = routerKey ? "https://openrouter.ai/api/v1" : "https://api.openai.com/v1";
  const payload = { ...(body as Record<string, unknown>) };
  if (routerKey) payload.model = `openai/${payload.model}`;
  const response = await fetch(`${baseUrl}/${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`, "Content-Type": "application/json",
      "HTTP-Referer": "https://orangepeelr.github.io/conference-rag/", "X-Title": "Conference Q&A",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    console.error("OpenAI request failed", response.status);
    throw new HttpError(response.status === 429 ? 429 : 502,
      response.status === 429 ? "AI usage limit reached. Please try again later." : "The AI service could not complete the request.");
  }
  return await response.json();
}
