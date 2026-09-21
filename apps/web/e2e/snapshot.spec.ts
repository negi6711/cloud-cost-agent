import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

import { uploadAndOpenReport } from "./support";

const CANONICAL = readFileSync(path.resolve(__dirname, "../../../fixtures/valid_cost_explorer.csv"));

async function openReport(page: Page, email: string, typesafeConsent: boolean): Promise<void> {
  await uploadAndOpenReport(page, email, { csv: CANONICAL.toString("utf8"), typesafeConsent });
}

test("a consented snapshot shows facts, labelled classification, and decision cards", async ({ page }, info) => {
  await openReport(page, `snap+${info.project.name}@example-co.com`, true);

  // Deterministic facts from the file.
  await expect(page.getByText("Spend covered")).toBeVisible();
  await expect(page.getByText("$23,013.75")).toBeVisible();
  await expect(page.getByText("$2,080.10 (29.6%)")).toBeVisible();
  await expect(page.getByText("85 / 100")).toBeVisible();

  // Classification is labelled for what it is: the local stand-in, never presented as Jev.
  await expect(page.getByText(/Test classifier \(not a real model\) was asked the same questions/)).toBeVisible();
  await expect(page.getByText(/TypeSafe Jev/)).toHaveCount(0);

  const cards = page.getByTestId("finding-card");
  await expect(cards).toHaveCount(2);
  const ecs = page.getByRole("article", { name: "New service: Amazon Elastic Container Service" });
  await expect(ecs).toContainText("Request evidence");
  await expect(ecs).toContainText("first appeared in July 2026 at $1,840.00");
  await expect(ecs).toContainText("Calculated from your file");
  // The rules publish the category; the model is shown beside it, agreeing or not.
  await expect(ecs).toContainText("Our rules decided Request evidence");
  await expect(ecs).toContainText("Test classifier (not a real model) agreed (90% confidence)");
  await expect(page.getByText(/Our rules decide every category here/)).toBeVisible();
  // This export has no tags, so the card asks for the allocation rather than for a team it cannot name.
  await expect(ecs).toContainText("Tag this spend to a team, or add a cost category");
  await expect(ecs).toContainText("team or cost-allocation tags");

  // Never a destructive recommendation from billing-only data (checked on the decision cards only;
  // the page's own "delete my data" control is not a recommendation).
  for (const card of await cards.all()) {
    expect(await card.innerText()).not.toMatch(/\b(resize|delete|terminate|shut down|purchase|buy)\b/i);
  }

  // Said once for the whole report, not repeated under every card.
  await expect(page.getByText(/Every finding below needs a person to confirm it/)).toHaveCount(1);
  await expect(page.getByText("Read this one with extra care")).toHaveCount(0);

  await expect(page.getByRole("region", { name: "Known limitations" })).toContainText("not guaranteed savings");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath(`snapshot-${info.project.name}.png`), fullPage: true });
});

test("without consent the snapshot is rule-based and says so", async ({ page }, info) => {
  await openReport(page, `noconsent+${info.project.name}@example-co.com`, false);
  await expect(page.getByText(/You did not allow model-assisted classification/).first()).toBeVisible();
  const ecs = page.getByRole("article", { name: "New service: Amazon Elastic Container Service" });
  await expect(ecs).toContainText("No model classified this finding, so there is no second opinion here.");
  await expect(ecs).toContainText("Read this one with extra care");
  await expect(ecs).toContainText("You did not allow model-assisted classification, so this finding is rule-based.");
});

test("findings are not available without signing in", async ({ request }) => {
  const res = await request.get("/api/snapshots/00000000-0000-4000-8000-000000000000/findings");
  expect(res.status()).toBe(401);
});
