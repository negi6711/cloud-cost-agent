import { expect, test } from "@playwright/test";

import { uploadAnonymously, unlockReport } from "./support";

const CSV = [
  "Service,Amazon Elastic Compute Cloud - Compute($),Amazon Simple Storage Service($),Total costs($)",
  "Service total,3300,330,3630",
  "2026-06-01,1000,100,1100",
  "2026-07-01,1100,110,1210",
  "2026-08-01,1200,120,1320",
  "",
].join("\n");

test("the upload page is open to anyone: no form, no account", async ({ page }) => {
  await page.goto("/upload");
  await expect(page.getByRole("heading", { name: "Upload your AWS billing export" })).toBeVisible();
  await expect(page.getByLabel("AWS billing export")).toBeVisible();
  await expect(page.getByText(/No email needed to see your headline figures/)).toBeVisible();
});

test("a valid CSV is analyzed without an email, and the figures come before the gate", async ({ page }, info) => {
  await uploadAnonymously(page, { csv: `${CSV}# ${info.project.name}\n`, mimeType: "application/vnd.ms-excel" });

  // The teaser: arithmetic on the file, shown with no email given.
  await expect(page.getByText("Calculated from your file")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Spend covered")).toBeVisible();
  await expect(page.getByText("$3,630.00")).toBeVisible();
  await expect(page.getByText("Largest driver")).toBeVisible();
  await expect(page.getByText("Cost impact to investigate", { exact: true })).toBeVisible();

  // The promise is investigation, never a saving.
  const teaser = await page.locator("body").innerText();
  expect(teaser).not.toMatch(/you (can|could|will) save|guaranteed savings|we'll save you/i);
  expect(teaser).toMatch(/money that moved, not money you can necessarily recover/i);
  expect(teaser).toMatch(/not guaranteed/i);

  // The gate discloses model-assisted classification before asking for anything.
  await expect(page.getByText(/classified with model assistance/)).toBeVisible();
  await expect(page.getByText(/TypeSafe does not train on this data/)).toBeVisible();
  await expect(page.getByLabel(/Allow model-assisted classification/)).toBeVisible();
  await expect(page.getByLabel(/I agree that you may process/)).not.toBeChecked();

  await unlockReport(page, `upload+${info.project.name}@example-co.com`);
  await expect(page.getByText(/one-time link/)).toBeVisible();
});

test("the gate refuses to unlock without permission to process the file", async ({ page }, info) => {
  await uploadAnonymously(page, { csv: `${CSV}# gate-${info.project.name}\n` });
  await expect(page.getByRole("heading", { name: "Unlock my full decision report" })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Work email", { exact: true }).fill(`nogate+${info.project.name}@example-co.com`);
  await page.getByLabel("First name", { exact: true }).fill("Pat");
  await page.getByLabel("Company name", { exact: true }).fill("Example Co");
  await page.getByRole("button", { name: "Unlock my full decision report" }).click();
  await expect(page.getByText(/We need your permission to process the file/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Check your email" })).toHaveCount(0);
});

test("a spreadsheet renamed to .csv is rejected with a readable message", async ({ page }) => {
  await page.goto("/upload");
  await page.getByLabel("AWS billing export").setInputFiles({
    name: "costs.csv",
    mimeType: "text/csv",
    buffer: Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("not really a csv")]),
  });
  await page.getByRole("button", { name: "Analyze my bill" }).click();
  await expect(page.getByText(/looks like a spreadsheet, archive, PDF or image, not a CSV/)).toBeVisible();
});

test("a CSV without a cost column is refused with an actionable reason", async ({ page }, info) => {
  await uploadAnonymously(page, {
    csv: `Date,Service,Region\n2026-06-01,AWS Lambda,us-east-1\n2026-07-01,AWS Lambda,us-east-1\n# ${info.project.name}\n`,
    filename: "costs.csv",
  });
  await expect(page.getByRole("heading", { name: "We could not process this file" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Required columns are missing: cost/)).toBeVisible();
  await page.getByRole("button", { name: "Upload a different file" }).click();
  await expect(page.getByRole("button", { name: "Analyze my bill" })).toBeVisible();
});

test("a single-month export ends with a clear 'not enough data' reason", async ({ page }, info) => {
  await uploadAnonymously(page, {
    csv: `Service,Amazon EC2($)\n2026-07-01,100\n# ${info.project.name}\n`,
    filename: "one-month.csv",
  });
  await expect(page.getByRole("heading", { name: "Not enough data for a snapshot" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/two consecutive complete months/)).toBeVisible();
});
