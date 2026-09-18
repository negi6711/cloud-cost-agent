import { expect, type Page, test } from "@playwright/test";

const CSV = [
  "Service,Amazon Elastic Compute Cloud - Compute($),Total costs($)",
  "Service total,3300,3300",
  "2026-06-01,1000,1000",
  "2026-07-01,1100,1100",
  "2026-08-01,1200,1200",
  "",
].join("\n");

/** Fill the form and upload a CSV (unique bytes per email). */
async function uploadAs(page: Page, email: string): Promise<void> {
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
  await page.getByLabel("AWS billing export").setInputFiles({
    name: "costexplorer.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(`${CSV}# ${email}\n`), // unique bytes per test, so dedupe never merges runs
  });
  await page.getByRole("button", { name: "Upload and analyze" }).click();
  await expect(page.getByText("File accepted")).toBeVisible();
}

/** The sign-in link from the newest dev-inbox email to `email`. */
async function emailedLink(page: Page, email: string): Promise<string> {
  await page.goto("/dev/inbox");
  const message = page.getByRole("listitem").filter({ has: page.getByTestId("inbox-to").getByText(email, { exact: true }) });
  await expect(message.first()).toBeVisible();
  const href = await message.first().getByRole("link").getAttribute("href");
  if (!href) throw new Error("no link in email");
  return href;
}

async function followEmailedLink(page: Page, email: string): Promise<string> {
  const link = await emailedLink(page, email);
  await page.goto(link);
  return link;
}

test("results require login; the emailed link signs the lead in and works only once", async ({ page, browser }, info) => {
  const email = `auth+${info.project.name}@example-co.com`;
  await uploadAs(page, email);

  const link = await followEmailedLink(page, email);
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

test("a signed-in lead cannot open another lead's snapshot", async ({ browser }, info) => {
  const ownerEmail = `owner+${info.project.name}@example-co.com`;
  const otherEmail = `other+${info.project.name}@example-co.com`;

  const ownerPage = await (await browser.newContext()).newPage();
  await uploadAs(ownerPage, ownerEmail);
  await followEmailedLink(ownerPage, ownerEmail);
  await expect(ownerPage).toHaveURL(/\/snapshot\/[0-9a-f-]{36}$/);
  const ownerSnapshotUrl = ownerPage.url();

  const otherPage = await (await browser.newContext()).newPage();
  await uploadAs(otherPage, otherEmail);
  await followEmailedLink(otherPage, otherEmail);
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
