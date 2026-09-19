import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, type Page, test } from "@playwright/test";

const CANONICAL = readFileSync(path.resolve(__dirname, "../../../fixtures/valid_cost_explorer.csv"));

async function uploadAndOpenSnapshot(page: Page, email: string, consent: boolean): Promise<void> {
  await page.goto("/#get-snapshot");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("First name").fill("Pat");
  await page.getByLabel("Company name").fill("Example Co");
  await page.getByLabel("Company website").fill("example-co.com");
  await page.getByLabel("Role").selectOption("Head of Platform");
  await page.getByLabel("Country").selectOption("GB");
  await page.getByLabel("Primary cloud provider").selectOption("AWS");
  await page.getByLabel("Estimated monthly cloud spend").selectOption("25k_75k");
  await page.getByLabel("Biggest current cloud-cost problem").fill("ECS appeared on the bill.");
  await page.getByLabel("You may contact me about my snapshot and a possible pilot.").check();
  await page.getByRole("button", { name: "Continue to upload" }).click();

  if (consent) await page.getByLabel(/Allow model-assisted classification/).check();
  await page.getByLabel("AWS billing export").setInputFiles({
    name: "costexplorer.csv",
    mimeType: "text/csv",
    buffer: CANONICAL,
  });
  await page.getByRole("button", { name: "Upload and analyze" }).click();
  await expect(page.getByRole("heading", { name: "Snapshot ready" })).toBeVisible({ timeout: 20_000 });

  await page.goto("/dev/inbox");
  const message = page
    .getByRole("listitem")
    .filter({ has: page.getByTestId("inbox-to").getByText(email, { exact: true }) });
  const href = await message.first().getByRole("link").getAttribute("href");
  await page.goto(href!);
  await expect(page.getByRole("heading", { name: "Cloud Cost Decision Snapshot" })).toBeVisible();
}

test("a consented snapshot shows facts, labelled classification, and decision cards", async ({ page }, info) => {
  await uploadAndOpenSnapshot(page, `snap+${info.project.name}@example-co.com`, true);

  // Deterministic facts from the file.
  await expect(page.getByText("Spend covered")).toBeVisible();
  await expect(page.getByText("$23,013.75")).toBeVisible();
  await expect(page.getByText("$2,080.10 (29.6%)")).toBeVisible();
  await expect(page.getByText("85 / 100")).toBeVisible();

  // Classification is labelled for what it is: the local stand-in, never presented as Jev.
  await expect(page.getByText(/classified with Test classifier \(not a real model\)/)).toBeVisible();
  await expect(page.getByText(/TypeSafe Jev/)).toHaveCount(0);

  const cards = page.getByTestId("finding-card");
  await expect(cards).toHaveCount(2);
  const ecs = page.getByRole("article", { name: "New service: Amazon Elastic Container Service" });
  await expect(ecs).toContainText("Request evidence");
  await expect(ecs).toContainText("first appeared in July 2026 at $1,840.00");
  await expect(ecs).toContainText("Calculated from your file");
  await expect(ecs).toContainText("Model-assisted · Test classifier (not a real model): suggested Request evidence (90% confidence)");
  await expect(ecs).toContainText("Confirm which team owns this spend");

  // Never a destructive recommendation from billing-only data.
  const text = await page.locator("main").innerText();
  const decisions = text.slice(text.indexOf("Decisions"), text.indexOf("Known limitations"));
  expect(decisions).not.toMatch(/\b(resize|delete|terminate|shut down|purchase|buy)\b/i);

  await expect(page.getByRole("region", { name: "Known limitations" })).toContainText("not guaranteed savings");
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: info.outputPath(`snapshot-${info.project.name}.png`), fullPage: true });
});

test("without consent the snapshot is rule-based and says so", async ({ page }, info) => {
  await uploadAndOpenSnapshot(page, `noconsent+${info.project.name}@example-co.com`, false);
  await expect(page.getByText(/You did not allow model-assisted classification/).first()).toBeVisible();
  const ecs = page.getByRole("article", { name: "New service: Amazon Elastic Container Service" });
  await expect(ecs).toContainText("Rule-based: no model classified this finding.");
  await expect(ecs).toContainText("Human review required");
  await expect(ecs).toContainText("You did not allow model-assisted classification, so this finding is rule-based.");
});

test("findings are not available without signing in", async ({ request }) => {
  const res = await request.get("/api/snapshots/00000000-0000-4000-8000-000000000000/findings");
  expect(res.status()).toBe(401);
});
