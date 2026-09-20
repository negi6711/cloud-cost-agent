import { expect, type Page, test } from "@playwright/test";

import { newestLink, unlockReport, uploadAnonymously } from "./support";

const CSV = [
  "Service,Amazon Elastic Compute Cloud - Compute($),Total costs($)",
  "Service total,3300,3300",
  "2026-06-01,1000,1000",
  "2026-07-01,1100,1100",
  "2026-08-01,1200,1200",
  "",
].join("\n");

/** Upload anonymously, then unlock with this email (unique bytes per email). */
async function uploadAndUnlock(page: Page, email: string): Promise<void> {
  await uploadAnonymously(page, { csv: `${CSV}# ${email}\n` });
  await unlockReport(page, email);
}

test("the report requires the emailed link, which signs the lead in and works only once", async ({ page, browser }, info) => {
  const email = `auth+${info.project.name}@example-co.com`;
  await uploadAndUnlock(page, email);

  const link = await newestLink(page, email);
  await page.goto(link);
  await expect(page).toHaveURL(/\/snapshot\/[0-9a-f-]{36}$/);
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Cloud Cost Decision Snapshot" })).toBeVisible();

  // Replaying the same link in a fresh browser does not sign anyone in.
  const replay = await (await browser.newContext()).newPage();
  await replay.goto(link);
  await expect(replay).toHaveURL(/\/login/);
  await expect(replay.getByText(/Signed in as/)).toHaveCount(0);
});

test("an unauthenticated visitor is sent to login", async ({ page }) => {
  await page.goto("/snapshot/00000000-0000-4000-8000-000000000000");
  await expect(page).toHaveURL(/\/login\?next=/);
  await expect(page.getByRole("heading", { name: "Sign in to view your snapshot" })).toBeVisible();
});

test("the visitor cookie alone never opens a report", async ({ page }, info) => {
  const email = `cookie+${info.project.name}@example-co.com`;
  await uploadAndUnlock(page, email);
  // Same browser, same upload session, but the emailed link has not been opened.
  const link = await newestLink(page, email);
  const runId = new URL(link, "http://localhost").searchParams.get("callbackURL")!.split("/").pop();
  await page.goto(`/snapshot/${runId}`);
  await expect(page).toHaveURL(/\/login\?next=/);
});

test("a signed-in lead cannot open another lead's snapshot", async ({ browser }, info) => {
  const ownerEmail = `owner+${info.project.name}@example-co.com`;
  const otherEmail = `other+${info.project.name}@example-co.com`;

  const ownerPage = await (await browser.newContext()).newPage();
  await uploadAndUnlock(ownerPage, ownerEmail);
  await ownerPage.goto(await newestLink(ownerPage, ownerEmail));
  await expect(ownerPage).toHaveURL(/\/snapshot\/[0-9a-f-]{36}$/);
  const ownerSnapshotUrl = ownerPage.url();

  const otherPage = await (await browser.newContext()).newPage();
  await uploadAndUnlock(otherPage, otherEmail);
  await otherPage.goto(await newestLink(otherPage, otherEmail));
  await expect(otherPage.getByText(`Signed in as ${otherEmail}`)).toBeVisible();

  const res = await otherPage.goto(ownerSnapshotUrl);
  expect(res?.status()).toBe(404);
});

test("login never reveals whether an email is known", async ({ page }) => {
  await page.goto("/login");
  await page.getByLabel("Work email").fill("stranger@example.org");
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText(/If that email has a snapshot with us, a sign-in link is on its way/)).toBeVisible();
  await page.goto("/dev/inbox");
  await expect(page.getByTestId("inbox-to").getByText("stranger@example.org", { exact: true })).toHaveCount(0);
});
