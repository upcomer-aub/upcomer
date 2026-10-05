import { expect, test } from "@playwright/test";

test("a student browses, searches and filters courses, then opens one", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Browse Courses" })).toBeVisible();
  const cards = page.locator("article");
  // Match a card by its code alone, since another course's name may mention the same code.
  const card = (code: string) => cards.filter({ has: page.getByText(code, { exact: true }) });
  // The catalog is paged in code order and an admin or the demo data can add many courses, so look each seeded one
  // up by code rather than expecting it on the first page.
  for (const code of ["EECE330", "EECE350", "MATH201"]) {
    await page.goto(`/?q=${code}`);
    await expect(card(code)).toHaveCount(1);
  }

  await page.goto("/");
  await page.getByRole("searchbox", { name: "Search courses" }).fill("eece 350");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page).toHaveURL(/q=eece\+350/);
  // Other courses may match too, but an exact code match is listed first.
  await expect(cards.first().getByText("EECE350", { exact: true })).toBeVisible();
  await expect(card("EECE330")).toHaveCount(0);
  await expect(card("MATH201")).toHaveCount(0);
  await expect(page.getByRole("searchbox", { name: "Search courses" })).toHaveValue("eece 350");

  await page.getByRole("searchbox", { name: "Search courses" }).fill("");
  await page.getByRole("combobox", { name: "Filter by faculty" }).selectOption({ label: "Faculty of Engineering" });
  await page.getByRole("button", { name: "Search" }).click();
  await expect(card("EECE350")).toHaveCount(1);
  await expect(card("EECE330")).toHaveCount(1);
  await expect(card("MATH201")).toHaveCount(0);

  await page.getByRole("combobox", { name: "Filter by professor" }).selectOption({ label: "Professor A" });
  await page.getByRole("button", { name: "Search" }).click();
  await expect(card("EECE350")).toHaveCount(1);
  await expect(card("EECE330")).toHaveCount(0);
  await expect(card("MATH201")).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Filter by faculty" })).toHaveValue("faculty-eng");
  await expect(page.getByRole("combobox", { name: "Filter by professor" })).toHaveValue("prof-a");

  await card("EECE350").getByRole("link", { name: "Open Course" }).click();
  await expect(page).toHaveURL(/\/courses\/course-eece350$/);
  await expect(page.getByRole("heading", { name: "Computer Networks" })).toBeVisible();
});

test("a search with no match shows a no-results message", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("searchbox", { name: "Search courses" }).fill("eece");
  await page.getByRole("combobox", { name: "Filter by faculty" }).selectOption({ label: "Faculty of Arts and Sciences" });
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("No courses found.")).toBeVisible();
  await expect(page.locator("article")).toHaveCount(0);
});

test("an unknown faculty in a link says it doesn't exist", async ({ page }) => {
  await page.goto("/?facultyId=unknown");
  await expect(page.getByText("The selected faculty doesn't exist.")).toBeVisible();
  await expect(page.getByText("No courses found.")).toBeVisible();
});
