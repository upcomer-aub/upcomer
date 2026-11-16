import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// US-51: the Generate / Try again button. While its form is being sent it is disabled and says generating can take up to a
// minute (also in a status line for screen readers); otherwise, and without JavaScript, it is a plain enabled submit button.

const status = vi.hoisted(() => ({ pending: undefined as boolean | undefined }));
vi.mock("react-dom", async importOriginal => {
  const actual = await importOriginal<typeof import("react-dom")>();
  // Without an override, React's own hook is used: on the server (no JavaScript yet) a form is never pending.
  return { ...actual, useFormStatus: () => (status.pending === undefined ? actual.useFormStatus() : { ...actual.useFormStatus(), pending: status.pending }) };
});
import { GENERATING_TEXT, WalkthroughSubmitButton } from "@/components/walkthrough-submit-button";

const render = (label = "Generate walkthrough") =>
  renderToStaticMarkup(<form action="/x" method="post"><WalkthroughSubmitButton label={label} describedBy="generate-note" /></form>);

beforeEach(() => {
  status.pending = undefined;
});

describe("WalkthroughSubmitButton (US-51)", () => {
  it("is a plain enabled submit button when rendered on the server, so it works without JavaScript", () => {
    const html = render();
    expect(html).toContain('<button class="button" type="submit" aria-describedby="generate-note">Generate walkthrough</button>');
    expect(html).not.toContain("disabled");
    expect(html).not.toContain(GENERATING_TEXT);
    // The status line is there but empty, so nothing is announced.
    expect(html).toMatch(/<span class="[^"]*" role="status"><\/span>/);
  });

  it("keeps its label (Try again) while not sending", () => {
    status.pending = false;
    expect(render("Try again")).toContain(">Try again</button>");
  });

  it("is disabled and says it can take up to a minute while the form is being sent", () => {
    status.pending = true;
    const html = render("Try again");
    expect(GENERATING_TEXT).toBe("Generating, this can take up to a minute…");
    expect(html).toContain(`<button class="button" type="submit" disabled="" aria-describedby="generate-note">${GENERATING_TEXT}</button>`);
    expect(html).toMatch(new RegExp(`<span class="[^"]*" role="status">${GENERATING_TEXT}</span>`));
    expect(html).not.toContain("Try again");
  });
});
