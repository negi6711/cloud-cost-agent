import { expect, type Page, test } from "@playwright/test";

async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test("landing page explains the product and shows the sample without signup", async ({ page }, info) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Turn your AWS bill into decisions, not dashboards." }),
  ).toBeVisible();
  await expect(page.getByText("Read-only by default. No AWS credentials required")).toBeVisible();

  const sample = page.getByRole("article", { name: "Example Cloud Cost Decision Snapshot" });
  await expect(sample).toContainText("REQUEST EVIDENCE");
  await expect(sample).toContainText("+$1,840/month");
  await expect(sample).toContainText("Awaiting human review");

  // No unsupported savings claims or autonomy promises (the "Not for" list mentions both as non-fit).
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/save (up to )?\d+ ?%|\d+ ?% (savings|cheaper)|cut your bill by|we guarantee/i);
  expect(text.match(/autonomous/gi) ?? []).toHaveLength(1);

  await expectNoHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath(`landing-${info.project.name}.png`), fullPage: true });
});

test("primary CTA goes straight to the upload page, with no form in front of it", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Get my free Cloud Cost Decision Snapshot" }).click();
  await expect(page).toHaveURL(/\/upload$/);
  await expect(page.getByRole("heading", { name: "Upload your AWS billing export" })).toBeVisible();
  await expect(page.getByLabel("AWS billing export")).toBeVisible();
  // Nothing is asked for before the file is read.
  await expect(page.getByLabel("Work email")).toHaveCount(0);
  await expectNoHorizontalScroll(page);
});

test("secondary CTA shows the example snapshot", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "View an example snapshot" }).click();
  await expect(page.getByRole("article", { name: "Example Cloud Cost Decision Snapshot" })).toBeInViewport();
});

test("the page says when an email is needed and when the file is deleted", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Upload my billing export" }).click();
  await expect(page).toHaveURL(/\/upload$/);
  await expect(page.getByText(/no email needed to see your headline figures/i)).toBeVisible();
  await expect(page.getByText(/deleted within 7 days/)).toBeVisible();
});
