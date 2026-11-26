// Preloaded only for the dedicated Playwright fake-provider run. The application still uses its production endpoint.
const fetchFromNode = globalThis.fetch;
globalThis.fetch = (input, options) => {
  if (input === "https://api.deepseek.com/chat/completions") {
    if (new Headers(options?.headers).get("Authorization") !== "Bearer upcomer-e2e-fake-key") {
      throw new Error("The test server requires its fake provider key");
    }
    return fetchFromNode("http://127.0.0.1:3219/chat/completions", options);
  }
  return fetchFromNode(input, options);
};
