import { readFileSync } from "node:fs";
import path from "node:path";

import { expect, test } from "@playwright/test";

import { newestLink, unlockReport, uploadAnonymously } from "./support";

const corpus = (name: string) => readFileSync(path.resolve(__dirname, "../../../fixtures/icp", name), "utf8");

/**
 * The loop: a customer comes back a month later and is told what became of last month's findings.
 *
 * Deliberately done in two browser contexts, because that is the real case — the visitor cookie
 * lives 24 hours, so a second upload a month later lands in a new workspace, and only the verified
 * email ties the two together.
 */
test("a second upload says what happened to the first report's findings", async ({ browser }, info) => {
  const email = `returning+${info.project.name}@example-co.com`;

  const july = await (await browser.newContext()).newPage();
  await uploadAnonymously(july, { csv: corpus("17a_month_one_cur.csv"), filename: "july.csv" });
  await unlockReport(july, email, { typesafeConsent: false });
  await july.goto(await newestLink(july, email));
  await expect(july.getByRole("heading", { name: "Cloud Cost Decision Snapshot" })).toBeVisible();
  // A first snapshot has nothing to compare against and says nothing about history.
  await expect(july.getByRole("heading", { name: /^Since / })).toHaveCount(0);

  // A month later: new browser, no cookie, so this upload starts its own workspace.
  const august = await (await browser.newContext()).newPage();
  await uploadAnonymously(august, { csv: corpus("17b_month_two_cur.csv"), filename: "august.csv" });
  await unlockReport(august, email, { typesafeConsent: false });
  await august.goto(await newestLink(august, email));

  const since = august.getByRole("region", { name: /^Since / });
  await expect(since).toBeVisible();
  await expect(since).toContainText("Jun 2026");
  // EC2 rose again, so it is still here and larger.
  await expect(since).toContainText("Amazon Elastic Compute Cloud");
  await expect(since).toContainText("still here, and larger");
  // S3's one-off jump did not repeat.
  await expect(since).toContainText("Amazon Simple Storage Service");
  await expect(since).toContainText("no longer a finding");
  // And the NAT gateway is new.
  await expect(since).toContainText("new since");

  // The claim stays honest: we report what the files say, not that we caused it.
  await expect(since).toContainText("not something a bill can show");
});
