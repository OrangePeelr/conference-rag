import { handler, HttpError, readBody } from "./http.ts";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

Deno.test("CORS preflight permits the deployed site without running the handler", async () => {
  const run = handler(async () => { throw new Error("Preflight must not reach application code"); });
  const result = await run(new Request("https://example.test", {
    method: "OPTIONS", headers: { origin: "https://orangepeelr.github.io" },
  }));
  assert(result.status === 204, "Expected successful preflight");
  assert(result.headers.get("Access-Control-Allow-Origin") === "https://orangepeelr.github.io", "Missing CORS header");
});

Deno.test("An unapproved browser origin never reaches the handler", async () => {
  const run = handler(async () => { throw new Error("Unapproved origin reached application code"); });
  const result = await run(new Request("https://example.test", {
    method: "POST", headers: { origin: "https://untrusted.example" }, body: "{}",
  }));
  assert(result.status === 403, "Expected origin rejection");
  assert(!result.headers.has("Access-Control-Allow-Origin"), "Untrusted origin received a CORS grant");
});

Deno.test("Chunked Unicode bodies are limited by bytes even without Content-Length", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ question: "🌎".repeat(51_000) }));
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 100_000));
      controller.enqueue(bytes.slice(100_000));
      controller.close();
    },
  });
  try {
    await readBody(new Request("https://example.test", { method: "POST", body: stream }));
    throw new Error("Oversized body was accepted");
  } catch (error) {
    assert(error instanceof HttpError && error.status === 413, "Expected 413 for too many bytes");
  }
});

Deno.test("Malformed JSON and non-object bodies get a client error", async () => {
  for (const body of ["{", "[]", "null", '"text"']) {
    try {
      await readBody(new Request("https://example.test", { method: "POST", body }));
      throw new Error("Invalid body was accepted");
    } catch (error) {
      assert(error instanceof HttpError && error.status === 400, "Expected 400 for an invalid body");
    }
  }
});

Deno.test("Unexpected exceptions do not expose internal details", async () => {
  const run = handler(async () => { throw new Error("sensitive upstream detail"); });
  const result = await run(new Request("https://example.test", { method: "POST", body: "{}" }));
  const body = await result.text();
  assert(result.status === 503, "Expected a service error");
  assert(!body.includes("sensitive upstream detail"), "Internal error detail was exposed");
});
