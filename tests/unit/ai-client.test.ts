import { describe, expect, it, vi } from "vitest";
import {
  AI_MAX_TOKENS, DEEPSEEK_DEFAULT_MODEL, DEEPSEEK_DEFAULT_URL, aiConfig, chatCompletion, isAiConfigured, readAnswer, resolveApiUrl,
} from "@/lib/ai-client";
import { walkthroughMessages } from "@/lib/walkthrough-rules";

// US-51: the AI client, with fetch always mocked. No test here ever reaches DeepSeek: every call passes its own `env` and
// `fetcher`, so the real key in .env is never read.

const KEY = "test-key-not-real";
const env = (over: Record<string, string | undefined> = {}) => ({ NODE_ENV: "test", DEEPSEEK_API_KEY: KEY, ...over }) as NodeJS.ProcessEnv;
const messages = [{ role: "user" as const, content: "Explain step 1." }];
const answer = (choice: Record<string, unknown>) => ({ choices: [{ index: 0, ...choice }] });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const fetcherFor = (response: () => Response | Promise<Response>) => vi.fn<typeof fetch>(async () => response());

describe("resolveApiUrl (US-51)", () => {
  it("uses DeepSeek's address when there is no override", () => {
    expect(resolveApiUrl(env())).toBe(DEEPSEEK_DEFAULT_URL);
    expect(resolveApiUrl(env({ DEEPSEEK_API_URL: "  " }))).toBe(DEEPSEEK_DEFAULT_URL);
  });

  it("allows a loopback address or DeepSeek's own outside production", () => {
    expect(resolveApiUrl(env({ DEEPSEEK_API_URL: "http://127.0.0.1:3999/chat/completions" }))).toBe("http://127.0.0.1:3999/chat/completions");
    expect(resolveApiUrl(env({ DEEPSEEK_API_URL: "http://localhost:3999/x" }))).toBe("http://localhost:3999/x");
    expect(resolveApiUrl(env({ DEEPSEEK_API_URL: "http://[::1]:3999/x" }))).toBe("http://[::1]:3999/x");
    expect(resolveApiUrl(env({ DEEPSEEK_API_URL: "https://api.deepseek.com/v1/chat/completions" }))).toBe("https://api.deepseek.com/v1/chat/completions");
  });

  it("ignores the override entirely in production, even a valid one", () => {
    expect(resolveApiUrl(env({ NODE_ENV: "production", DEEPSEEK_API_URL: "http://127.0.0.1:3999/x" }))).toBe(DEEPSEEK_DEFAULT_URL);
    expect(resolveApiUrl(env({ NODE_ENV: "production", DEEPSEEK_API_URL: "https://evil.example.com/x" }))).toBe(DEEPSEEK_DEFAULT_URL);
  });

  it("refuses any other override instead of falling back to the real provider", () => {
    for (const url of [
      "https://evil.example.com/chat/completions",
      "http://api.deepseek.com/chat/completions", // not https
      "https://api.deepseek.com.evil.example/x",
      "https://api.deepseek.com:8443/x",
      "http://10.0.0.5:3999/x",
      "http://user:pass@127.0.0.1:3999/x",
      "ftp://127.0.0.1/x",
      "file:///etc/passwd",
      "not a url",
    ]) expect(resolveApiUrl(env({ DEEPSEEK_API_URL: url })), url).toBeNull();
  });
});

describe("aiConfig (US-51)", () => {
  it("needs a key", () => {
    expect(aiConfig(env({ DEEPSEEK_API_KEY: undefined }))).toBeNull();
    expect(aiConfig(env({ DEEPSEEK_API_KEY: "   " }))).toBeNull();
    expect(isAiConfigured(env({ DEEPSEEK_API_KEY: "" }))).toBe(false);
    expect(isAiConfigured(env())).toBe(true);
  });

  it("uses DEEPSEEK_MODEL, or deepseek-flash when it is empty", () => {
    expect(aiConfig(env())?.model).toBe(DEEPSEEK_DEFAULT_MODEL);
    expect(aiConfig(env({ DEEPSEEK_MODEL: " " }))?.model).toBe("deepseek-flash");
    expect(aiConfig(env({ DEEPSEEK_MODEL: "deepseek-other" }))?.model).toBe("deepseek-other");
  });

  it("is not configured when the override address is refused", () => {
    expect(aiConfig(env({ DEEPSEEK_API_URL: "https://evil.example.com" }))).toBeNull();
  });
});

describe("readAnswer (US-51)", () => {
  it("returns only the content, never the reasoning", () => {
    const result = readAnswer(answer({ message: { role: "assistant", content: "the answer", reasoning_content: "SECRET THINKING" }, finish_reason: "stop" }));
    expect(result).toEqual({ ok: true, content: "the answer" });
    expect(JSON.stringify(result)).not.toContain("SECRET THINKING");
  });

  it("refuses a cut-off answer, even with text in it", () => {
    expect(readAnswer(answer({ message: { content: "half an ans" }, finish_reason: "length" }))).toEqual({ ok: false, error: "truncated" });
  });

  it("refuses an empty answer, including one with reasoning only", () => {
    expect(readAnswer(answer({ message: { content: "" }, finish_reason: "stop" }))).toEqual({ ok: false, error: "empty" });
    expect(readAnswer(answer({ message: { content: " \n " }, finish_reason: "stop" }))).toEqual({ ok: false, error: "empty" });
    expect(readAnswer(answer({ message: { content: null, reasoning_content: "thinking" }, finish_reason: "stop" }))).toEqual({ ok: false, error: "empty" });
  });

  it("refuses a response that is not the expected shape", () => {
    for (const body of [null, "text", 42, {}, { choices: [] }, { choices: "x" }, { choices: [null] }, { choices: [{}] }, { choices: [{ message: "x" }] }, answer({ message: { content: 7 } })]) {
      expect(readAnswer(body), JSON.stringify(body)).toEqual({ ok: false, error: "malformed" });
    }
  });
});

describe("chatCompletion (US-51)", () => {
  it("sends one non-streaming request with the key in the header only", async () => {
    const fetcher = fetcherFor(() => json(answer({ message: { content: "ok" }, finish_reason: "stop" })));
    const result = await chatCompletion(messages, { env: env({ DEEPSEEK_MODEL: "m-1" }), fetcher });
    expect(result).toEqual({ ok: true, content: "ok", model: "m-1" });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(DEEPSEEK_DEFAULT_URL);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(init.headers).toEqual({ "Content-Type": "application/json", Authorization: `Bearer ${KEY}` });
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ model: "m-1", messages, stream: false, max_tokens: AI_MAX_TOKENS, response_format: { type: "json_object" } });
    expect(String(init.body)).not.toContain(KEY);
  });

  it("asks for JSON mode, and the walkthrough prompt mentions JSON as JSON mode requires", async () => {
    const fetcher = fetcherFor(() => json(answer({ message: { content: "{}" }, finish_reason: "stop" })));
    const prompt = walkthroughMessages({ question: "Explain DNS caching.", topic: null, course: "EECE350" });
    await chatCompletion(prompt, { env: env(), fetcher });
    const sent = JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body));
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.messages[0].content).toMatch(/\bJSON\b/);
    expect(sent.messages.map((message: { content: string }) => message.content).join("\n").toLowerCase()).toContain("json");
  });

  it("sends to an allowed test address, and never calls out when not configured", async () => {
    const fetcher = fetcherFor(() => json(answer({ message: { content: "ok" }, finish_reason: "stop" })));
    await chatCompletion(messages, { env: env({ DEEPSEEK_API_URL: "http://127.0.0.1:3999/chat/completions" }), fetcher, maxTokens: 100 });
    expect(fetcher.mock.calls[0][0]).toBe("http://127.0.0.1:3999/chat/completions");
    expect(JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body)).max_tokens).toBe(100);

    fetcher.mockClear();
    expect(await chatCompletion(messages, { env: env({ DEEPSEEK_API_KEY: "" }), fetcher })).toEqual({ ok: false, error: "not_configured" });
    expect(await chatCompletion(messages, { env: env({ DEEPSEEK_API_URL: "https://evil.example.com" }), fetcher })).toEqual({ ok: false, error: "not_configured" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns the status of an error response without reading its body", async () => {
    const response = json({ error: { message: "Authentication failed for key test-key-not-real" } }, 401);
    const text = vi.spyOn(response, "text");
    const result = await chatCompletion(messages, { env: env(), fetcher: fetcherFor(() => response) });
    expect(result).toEqual({ ok: false, error: "http_error", status: 401 });
    expect(text).not.toHaveBeenCalled();
    expect(await chatCompletion(messages, { env: env(), fetcher: fetcherFor(() => new Response("busy", { status: 503 })) })).toEqual({ ok: false, error: "http_error", status: 503 });
  });

  it("turns a network failure into network_error and never throws", async () => {
    const fetcher = vi.fn(async () => { throw new TypeError("fetch failed"); });
    expect(await chatCompletion(messages, { env: env(), fetcher: fetcher as unknown as typeof fetch })).toEqual({ ok: false, error: "network_error" });
  });

  it("gives up after the timeout", async () => {
    // A request that never answers until it is aborted.
    const fetcher = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const started = Date.now();
    expect(await chatCompletion(messages, { env: env(), fetcher: fetcher as unknown as typeof fetch, timeoutMs: 30 })).toEqual({ ok: false, error: "timeout" });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("gives up when the body is still arriving at the timeout", async () => {
    const fetcher = vi.fn(async (_url: string, init: RequestInit) => {
      const response = new Response("{}", { status: 200 });
      vi.spyOn(response, "text").mockImplementation(() => new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      }));
      return response;
    });
    expect(await chatCompletion(messages, { env: env(), fetcher: fetcher as unknown as typeof fetch, timeoutMs: 30 })).toEqual({ ok: false, error: "timeout" });
  });

  it("refuses a body that is not JSON, a cut-off answer and an empty answer", async () => {
    const run = (response: () => Response) => chatCompletion(messages, { env: env(), fetcher: fetcherFor(response) });
    expect(await run(() => new Response("<html>gateway</html>", { status: 200 }))).toEqual({ ok: false, error: "malformed" });
    expect(await run(() => json(answer({ message: { content: "{\"steps\":[" }, finish_reason: "length" })))).toEqual({ ok: false, error: "truncated" });
    expect(await run(() => json(answer({ message: { content: "", reasoning_content: "thinking only" }, finish_reason: "stop" })))).toEqual({ ok: false, error: "empty" });
  });
});
