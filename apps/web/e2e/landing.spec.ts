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

test("primary CTA opens the qualification form", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "Get my free Cloud Cost Decision Snapshot" }).click();
  await expect(page).toHaveURL(/#get-snapshot$/);
  await expect(page.getByLabel("Work email")).toBeInViewport();
});

test("secondary CTA shows the example snapshot", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("link", { name: "View an example snapshot" }).click();
  await expect(page.getByRole("article", { name: "Example Cloud Cost Decision Snapshot" })).toBeInViewport();
});

test("the form shows readable errors and does not submit when invalid", async ({ page }) => {
  await page.goto("/#get-snapshot");
  await page.getByLabel("Work email").fill("not-an-email");
  await page.getByRole("button", { name: "Continue to upload" }).click();
  await expect(page.getByText("Please check the highlighted fields.")).toBeVisible();
  await expect(page.getByText("Enter a valid work email")).toBeVisible();
  await expect(page.getByText("We need permission to contact you about your snapshot")).toBeVisible();
  await expect(page).toHaveURL(/\/#get-snapshot$/);
});

test("a complete form continues to the upload step", async ({ page }, info) => {
  await page.goto("/#get-snapshot");
  await page.getByLabel("Work email").fill(`e2e+${info.project.name}@example-co.com`);
  await page.getByLabel("First name").fill("Pat");
  await page.getByLabel("Company name").fill("Example Co");
  await page.getByLabel("Company website").fill("example-co.com");
  await page.getByLabel("Role").selectOption("Head of Platform");
  await page.getByLabel("Country").selectOption("GB");
  await page.getByLabel("Primary cloud provider").selectOption("AWS");
  await page.getByLabel("Estimated monthly cloud spend").selectOption("25k_75k");
  await page.getByLabel("Biggest current cloud-cost problem").fill("ECS spend jumped last month.");
  await page.getByLabel("You may contact me about my snapshot and a possible pilot.").check();
  await page.getByRole("button", { name: "Continue to upload" }).click();

  await expect(page).toHaveURL(/\/upload$/);
  await expect(page.getByRole("heading", { name: "Upload your AWS billing export" })).toBeVisible();
  await expectNoHorizontalScroll(page);
});
