import { expect, type Page } from "@playwright/test";

/**
 * The flow every spec starts from: upload with no account, read the figures calculated from the
 * file, then hand over an email to unlock the full report.
 */

export interface UploadOptions {
  /** Unique bytes per test, so duplicate detection never merges two runs. */
  csv: string;
  filename?: string;
  mimeType?: string;
}

/** Upload a file as an anonymous visitor and wait for the deterministic teaser. */
export async function uploadAnonymously(page: Page, { csv, filename = "costexplorer.csv", mimeType = "text/csv" }: UploadOptions): Promise<void> {
  await page.goto("/upload");
  await page.getByLabel("AWS billing export").setInputFiles({ name: filename, mimeType, buffer: Buffer.from(csv) });
  await page.getByRole("button", { name: "Analyze my bill" }).click();
}

/** Fill the email gate shown under the teaser. */
export async function unlockReport(
  page: Page,
  email: string,
  { typesafeConsent = true, company = "Example Co", firstName = "Pat" } = {},
): Promise<void> {
  await expect(page.getByRole("heading", { name: "Unlock my full decision report" })).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Work email", { exact: true }).fill(email);
  await page.getByLabel("First name", { exact: true }).fill(firstName);
  await page.getByLabel("Company name", { exact: true }).fill(company);
  await page.getByLabel(/Your role/).selectOption("Head of Platform");
  await page.getByLabel(/I agree that you may process/).check();
  const consent = page.getByLabel(/Allow model-assisted classification/);
  if (typesafeConsent) await consent.check();
  else await consent.uncheck();
  await page.getByRole("button", { name: "Unlock my full decision report" }).click();
  await expect(page.getByRole("heading", { name: "Check your email" })).toBeVisible();
}

/** The newest dev-inbox link sent to an address. */
export async function newestLink(page: Page, email: string): Promise<string> {
  await page.goto("/dev/inbox");
  const message = page
    .getByRole("listitem")
    .filter({ has: page.getByTestId("inbox-to").getByText(email, { exact: true }) });
  await expect(message.first()).toBeVisible();
  const href = await message.first().getByRole("link").getAttribute("href");
  if (!href) throw new Error("no link in email");
  return href;
}

/** Upload, unlock, and open the report through the emailed one-time link. */
export async function uploadAndOpenReport(
  page: Page,
  email: string,
  options: UploadOptions & { typesafeConsent?: boolean; company?: string; firstName?: string },
): Promise<void> {
  const typesafeConsent = options.typesafeConsent ?? true;
  await uploadAnonymously(page, options);
  await unlockReport(page, email, {
    typesafeConsent,
    ...(options.company ? { company: options.company } : {}),
    ...(options.firstName ? { firstName: options.firstName } : {}),
  });
  await page.goto(await newestLink(page, email));
  await expect(page.getByRole("heading", { name: "Cloud Cost Decision Snapshot" })).toBeVisible();
  // Unlocking starts the classification phase in the worker; the report page is not live-updating,
  // so reload until that phase has landed.
  // The classification phase has landed once the banner names the model that was asked.
  if (typesafeConsent) await reloadUntil(page, /was asked the same questions/);
}

async function reloadUntil(page: Page, pattern: RegExp, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (pattern.test(await page.locator("body").innerText())) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${pattern} on ${page.url()}`);
    }
    await page.waitForTimeout(1_000);
    await page.reload();
  }
}
