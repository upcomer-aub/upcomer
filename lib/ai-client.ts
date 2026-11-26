import { logError } from "@/lib/logger";

// Server-side DeepSeek gateway. Only the completion content is read from a successful response.

export const DEEPSEEK_DEFAULT_URL = "https://api.deepseek.com/chat/completions";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";
// Long enough for a slow answer, short enough that a student is not left waiting on a hung request.
export const AI_TIMEOUT_MS = 45_000;
// Reasoning tokens count toward max_tokens, so leave room for the thinking as well as the answer; a cut-off answer is refused.
export const AI_MAX_TOKENS = 4096;

export type AiMessage = { role: "system" | "user"; content: string };

// not_configured: no key, or an override address that is not allowed. timeout: no complete answer in time. network_error:
// the provider could not be reached. http_error: it answered with a non-2xx status. malformed: the response was not the
// expected JSON. empty: no answer text. truncated: the answer was cut off (finish_reason "length").
export type AiFailure = "not_configured" | "timeout" | "network_error" | "http_error" | "malformed" | "empty" | "truncated";
export type AiResult = { ok: true; content: string; model: string } | { ok: false; error: AiFailure; status?: number };

export type AiPrompt<Input, Output> = {
  feature: "practice" | "walkthrough" | "mock_feedback";
  version: string;
  messages: (input: Input) => AiMessage[];
  validate: (content: string, input: Input) => { ok: true; value: Output } | { ok: false; error: string };
};

export async function runAiPrompt<Input, Output>(
  prompt: AiPrompt<Input, Output>,
  input: Input,
  options: ChatOptions = {},
  request = chatCompletion,
) {
  const start = Date.now();
  const response = await request(prompt.messages(input), options);
  const parsed = response.ok ? prompt.validate(response.content, input) : null;
  const env = options.env ?? process.env;
  logError("ai_provider_result", {
    feature: prompt.feature,
    model: response.ok ? response.model : env.DEEPSEEK_MODEL?.trim() || DEEPSEEK_DEFAULT_MODEL,
    promptVersion: prompt.version,
    durationMs: String(Date.now() - start),
    resultCode: response.ok ? (parsed?.ok ? "ok" : "invalid_output") : response.error,
  });
  if (!response.ok) return response;
  if (!parsed?.ok) return { ok: false as const, error: "invalid_output" as const, validationError: parsed?.error };
  return { ok: true as const, value: parsed.value, model: response.model };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The chat-completions address. DEEPSEEK_API_URL may point the client at a local fake server for tests, but it is ignored
// entirely when NODE_ENV is "production"; otherwise only https://api.deepseek.com or a loopback address is allowed. An
// override that is set but not allowed gives null (refused), never a silent fallback, so a mistyped test address cannot
// send the key to the real provider or anywhere else.
export function resolveApiUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const override = env.DEEPSEEK_API_URL?.trim();
  if (!override || env.NODE_ENV === "production") return DEEPSEEK_DEFAULT_URL;
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    return null;
  }
  if (url.username || url.password) return null;
  const deepseek = url.protocol === "https:" && url.hostname === "api.deepseek.com" && (url.port === "" || url.port === "443");
  const loopback = (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK_HOSTS.has(url.hostname);
  return deepseek || loopback ? url.href : null;
}

export type AiConfig = { url: string; key: string; model: string };

// The provider settings, or null when the key is missing or the override address is refused.
export function aiConfig(env: NodeJS.ProcessEnv = process.env): AiConfig | null {
  const key = env.DEEPSEEK_API_KEY?.trim();
  const url = resolveApiUrl(env);
  if (!key || !url) return null;
  return { url, key, model: env.DEEPSEEK_MODEL?.trim() || DEEPSEEK_DEFAULT_MODEL };
}

export const isAiConfigured = (env: NodeJS.ProcessEnv = process.env) => aiConfig(env) !== null;

// Reads only choices[0].message.content and choices[0].finish_reason; everything else in the response is ignored.
export function readAnswer(body: unknown): { ok: true; content: string } | { ok: false; error: "malformed" | "empty" | "truncated" } {
  if (typeof body !== "object" || body === null) return { ok: false, error: "malformed" };
  const choices = (body as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || !choices.length || typeof choices[0] !== "object" || choices[0] === null) return { ok: false, error: "malformed" };
  const choice = choices[0] as { message?: unknown; finish_reason?: unknown };
  if (choice.finish_reason === "length") return { ok: false, error: "truncated" };
  const message = choice.message;
  if (typeof message !== "object" || message === null) return { ok: false, error: "malformed" };
  const content = (message as { content?: unknown }).content;
  if (content === null || content === undefined) return { ok: false, error: "empty" };
  if (typeof content !== "string") return { ok: false, error: "malformed" };
  if (!content.trim()) return { ok: false, error: "empty" };
  return { ok: true, content };
}

export type ChatOptions = { maxTokens?: number; timeoutMs?: number; env?: NodeJS.ProcessEnv; fetcher?: typeof fetch };

// One non-streaming chat completion. Never throws: every failure is a typed result. The timeout covers the whole exchange,
// reading the body included. Redirects are refused, so the key is never forwarded to another address. An error response's
// body is not read (only its status is kept), so nothing from it can reach a log or a page.
export async function chatCompletion(messages: AiMessage[], options: ChatOptions = {}): Promise<AiResult> {
  const config = aiConfig(options.env);
  if (!config) return { ok: false, error: "not_configured" };
  const fetcher = options.fetcher ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? AI_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      response = await fetcher(config.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.key}` },
        // Each feature requests JSON and validates the returned content.
        body: JSON.stringify({ model: config.model, messages, stream: false, max_tokens: options.maxTokens ?? AI_MAX_TOKENS, response_format: { type: "json_object" } }),
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
      });
    } catch {
      return { ok: false, error: controller.signal.aborted ? "timeout" : "network_error" };
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      return { ok: false, error: "http_error", status: response.status };
    }
    let body: unknown;
    try {
      body = JSON.parse(await response.text());
    } catch {
      return { ok: false, error: controller.signal.aborted ? "timeout" : "malformed" };
    }
    const answer = readAnswer(body);
    return answer.ok ? { ok: true, content: answer.content, model: config.model } : answer;
  } finally {
    clearTimeout(timer);
  }
}
