import { performance } from "node:perf_hooks";

// A minimal HTTP client for the running app: one cookie jar per client, no automatic redirects, and timing per request.

export type Reply = { status: number; location: string; body: string; bytes: Buffer; contentType: string; ms: number };

export class Client {
  private cookies = new Map<string, string>();

  constructor(private baseUrl: string) {}

  get session() {
    return this.cookies.get("upcomer_session");
  }

  setSession(token: string | undefined) {
    if (token) this.cookies.set("upcomer_session", token);
    else this.cookies.delete("upcomer_session");
  }

  async request(path: string, init: { method?: string; body?: FormData | string; headers?: Record<string, string>; timeoutMs?: number } = {}): Promise<Reply> {
    const headers: Record<string, string> = { ...init.headers };
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    // A browser posts with its Origin; the server-action CSRF check compares it with the host.
    if (init.method === "POST") headers.origin = this.baseUrl;
    const started = performance.now();
    // An optional time limit (used by npm run availability); the fetch then rejects with a TimeoutError.
    const signal = init.timeoutMs ? AbortSignal.timeout(init.timeoutMs) : undefined;
    const response = await fetch(new URL(path, this.baseUrl), { method: init.method ?? "GET", body: init.body, headers, redirect: "manual", signal });
    const bytes = Buffer.from(await response.arrayBuffer());
    const ms = performance.now() - started;
    for (const cookie of response.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(";");
      const [name, ...rest] = pair.split("=");
      const value = rest.join("=");
      const expired = !value || attributes.some(attribute => /^\s*(max-age=0|expires=Thu, 01 Jan 1970)/i.test(attribute));
      if (expired) this.cookies.delete(name.trim());
      else this.cookies.set(name.trim(), value);
    }
    return {
      status: response.status, location: response.headers.get("location") ?? "", body: bytes.toString("utf8"), bytes,
      contentType: response.headers.get("content-type") ?? "", ms,
    };
  }

  get(path: string, timeoutMs?: number) {
    return this.request(path, { timeoutMs });
  }

  // Submits a server-action form the way a browser without JavaScript does: a multipart POST with the action's hidden ID field.
  postAction(path: string, actionId: string, fields: Record<string, string | string[]>, timeoutMs?: number) {
    const form = new FormData();
    form.append(actionId, "");
    for (const [name, value] of Object.entries(fields)) for (const item of [value].flat()) form.append(name, item);
    return this.request(path, { method: "POST", body: form, timeoutMs });
  }
}

// Finds the hidden action field of the form that contains the given button text.
export function actionIdFor(html: string, buttonText: string) {
  for (const form of html.match(/<form[\s\S]*?<\/form>/g) ?? []) {
    const id = form.match(/name="(\$ACTION_ID_[0-9a-f]+)"/)?.[1];
    if (id && form.includes(`>${buttonText}</button>`)) return id;
  }
  throw new Error(`No server-action form with the button "${buttonText}"`);
}

// Describes a reply in a few words for the report, e.g. "303 → /signup?error=weak_password" or "404".
export const describe = (reply: Reply) => (reply.location ? `${reply.status} → ${reply.location}` : String(reply.status));
