import { openai } from "./openai.ts";

Deno.test("OpenRouter routes embeddings and DeepSeek answers to their providers", async () => {
  const originalFetch = globalThis.fetch;
  const originalRouterKey = Deno.env.get("OPENROUTER_API_KEY");
  Deno.env.set("OPENROUTER_API_KEY", "test-router-key");
  const requests: { url: string; body: Record<string, unknown> }[] = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
    return Response.json({ ok: true });
  };
  try {
    await openai("embeddings", { model: "text-embedding-3-small", input: "Peace", dimensions: 1536 });
    await openai("chat/completions", { model: "deepseek/deepseek-v4.1-flash-1017", messages: [] });
    if (requests[0].url !== "https://openrouter.ai/api/v1/embeddings" ||
        requests[0].body.model !== "openai/text-embedding-3-small" ||
        requests[0].body.dimensions !== 1536) {
      throw new Error("Embedding route or dimensions changed");
    }
    if (requests[1].url !== "https://openrouter.ai/api/v1/chat/completions" ||
        requests[1].body.model !== "deepseek/deepseek-v4.1-flash-1017") {
      throw new Error("DeepSeek answer request used the wrong provider or model");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalRouterKey === undefined) Deno.env.delete("OPENROUTER_API_KEY");
    else Deno.env.set("OPENROUTER_API_KEY", originalRouterKey);
  }
});
