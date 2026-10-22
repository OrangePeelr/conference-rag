import { authenticate, consumeQuota } from "../_shared/auth.ts";
import { handler, json, questionFrom, readBody } from "../_shared/http.ts";
import { openai } from "../_shared/openai.ts";

Deno.serve(handler(async (req) => {
  const headers = await authenticate(req);
  const body = await readBody(req);
  if (body.healthcheck === true) return json(req, {
    ready: Boolean(Deno.env.get("OPENROUTER_API_KEY") || Deno.env.get("OPENAI_API_KEY")),
  });
  const question = questionFrom(body);
  await consumeQuota(headers);
  const result = await openai("embeddings", {
    model: "text-embedding-3-small", input: question, dimensions: 1536,
  });
  return json(req, { embedding: result.data[0].embedding });
}));
