import { expect, type Page, test } from "@playwright/test";

const CSV = [
  "Service,Amazon Elastic Compute Cloud - Compute($),Amazon Simple Storage Service($),Total costs($)",
  "Service total,3300,330,3630",
  "2026-06-01,1000,100,1100",
  "2026-07-01,1100,110,1210",
  "2026-08-01,1200,120,1320",
  "",
].join("\n");

async function completeForm(page: Page, email: string) {
  await page.goto("/#get-snapshot");
  await page.getByLabel("Work email").fill(email);
  await page.getByLabel("First name").fill("Pat");
  await page.getByLabel("Company name").fill("Example Co");
  await page.getByLabel("Company website").fill("example-co.com");
  await page.getByLabel("Role").selectOption("CTO");
  await page.getByLabel("Country").selectOption("US");
  await page.getByLabel("Primary cloud provider").selectOption("AWS");
  await page.getByLabel("Estimated monthly cloud spend").selectOption("10k_25k");
  await page.getByLabel("Biggest current cloud-cost problem").fill("Bill doubled.");
  await page.getByLabel("You may contact me about my snapshot and a possible pilot.").check();
  await page.getByRole("button", { name: "Continue to upload" }).click();
  await expect(page.getByRole("heading", { name: "Upload your AWS billing export" })).toBeVisible();
}

test("upload page requires the form first", async ({ page }) => {
  await page.goto("/upload");
  await expect(page.getByRole("heading", { name: "Start with a few questions" })).toBeVisible();
});

test("a valid CSV uploads with progress, is verified by the worker, and results stay behind login", async ({ page }, info) => {
  await completeForm(page, `upload+${info.project.name}@example-co.com`);

  const consent = page.getByLabel(/Allow model-assisted classification/);
  await expect(consent).not.toBeChecked(); // opt-in, never pre-ticked
  await expect(page.getByText(/TypeSafe does not train on this data/)).toBeVisible();
  await consent.check();

  await page.getByLabel("AWS billing export").setInputFiles({
    name: "costexplorer.csv",
    mimeType: "application/vnd.ms-excel", // what Windows often claims for .csv; must not matter
    buffer: Buffer.from(CSV),
  });
  await page.getByRole("button", { name: "Upload and analyze" }).click();

  await expect(page.getByText("File accepted")).toBeVisible();
  // The worker picks the job up (kicked by the web app) and verifies the file's integrity.
  await expect(page.getByRole("heading", { name: "Reading your file" })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/the snapshot is shown only after you sign in/)).toBeVisible();
});

test("a spreadsheet renamed to .csv is rejected with a readable message", async ({ page }, info) => {
  await completeForm(page, `reject+${info.project.name}@example-co.com`);
  await page.getByLabel("AWS billing export").setInputFiles({
    name: "costs.csv",
    mimeType: "text/csv",
    buffer: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("not really a csv")]),
  });
  await page.getByRole("button", { name: "Upload and analyze" }).click();
  await expect(page.getByText(/looks like a spreadsheet, archive, PDF or image, not a CSV/)).toBeVisible();
});

test("a visitor can ask for a manual review instead of uploading", async ({ page }, info) => {
  await completeForm(page, `manual+${info.project.name}@example-co.com`);
  await page.getByRole("button", { name: "Request a manual review instead" }).click();
  await expect(page.getByRole("heading", { name: "Manual review requested" })).toBeVisible();
});
