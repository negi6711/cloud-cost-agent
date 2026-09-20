import { expect, type Page, test } from "@playwright/test";

import { newestLink, uploadAndOpenReport } from "./support";

const ADMIN = "founder@admin.test"; // ADMIN_EMAILS in playwright.config.ts
const CSV = "Service,Amazon EC2($),Amazon ECS($)\nService total,2100,900\n2026-07-01,1000,0\n2026-08-01,1100,900\n";

async function signIn(page: Page, email: string, next: string): Promise<void> {
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  await page.getByLabel("Work email").fill(email);
  await page.getByRole("button", { name: "Email me a sign-in link" }).click();
  await expect(page.getByText(/sign-in link is on its way/)).toBeVisible();
  await page.goto(await newestLink(page, email));
}

/** A prospect uploads anonymously, unlocks with their email, and opens the report. */
async function prospectUploads(page: Page, email: string, company: string): Promise<void> {
  await uploadAndOpenReport(page, email, { csv: `${CSV}# ${email}
`, filename: "ce.csv", company });
}

/** Answer the optional questions shown under the report after unlock. */
async function answerProfile(page: Page, problem: string): Promise<void> {
  await page.getByLabel("Where are you based?").selectOption("DE");
  await page.getByLabel("Primary cloud").selectOption("AWS");
  await page.getByLabel("Monthly cloud spend").selectOption("10k_25k");
  await page.getByLabel("What is your biggest cloud cost problem right now?").fill(problem);
  await page.getByRole("button", { name: "Send answers" }).click();
  await expect(page.getByText(/that helps us make the next snapshot more useful/)).toBeVisible();
}

test("the founder can work a lead: status, note, links, and deletion", async ({ browser }, info) => {
  const prospect = await (await browser.newContext()).newPage();
  const email = `queue+${info.project.name}@example-co.com`;
  const company = `Queue Co ${info.project.name}`;
  await prospectUploads(prospect, email, company);
  await answerProfile(prospect, "Containers appeared.");

  const admin = await (await browser.newContext()).newPage();
  await signIn(admin, ADMIN, "/admin");
  await expect(admin.getByRole("heading", { name: "Lead queue" })).toBeVisible();
  await admin.getByRole("link", { name: company }).click();
  await expect(admin.getByRole("heading", { name: new RegExp(company) })).toBeVisible();
  await expect(admin.getByText("Containers appeared.")).toBeVisible();

  await admin.getByLabel("Lead status").selectOption("snapshot_sent");
  await expect(admin.getByLabel("Lead status")).toHaveValue("snapshot_sent");

  await admin.getByLabel("Reviewed note (internal)").fill("Called Sam; ECS is a new service mesh pilot.");
  await admin.getByRole("button", { name: "Add note" }).click();
  await expect(admin.getByText("Called Sam; ECS is a new service mesh pilot.")).toBeVisible();

  const copy = admin.getByRole("button", { name: "Copy result link" });
  await expect(copy).toHaveAttribute("data-url", /\/snapshot\/[0-9a-f-]{36}$/);
  await admin.getByRole("button", { name: "Email sign-in link" }).click();
  await expect(admin.getByRole("button", { name: "Sign-in link sent" })).toBeVisible();

  // The admin can open the prospect's snapshot.
  await admin.getByRole("link", { name: /^Snapshot / }).click();
  await expect(admin.getByText(`Signed in as ${ADMIN} · admin`)).toBeVisible();
  await expect(admin.getByTestId("finding-card").first()).toBeVisible();

  await admin.goBack();
  await admin.getByRole("button", { name: "Delete file and snapshot" }).click();
  await admin.getByRole("button", { name: "Delete permanently" }).click();
  await expect(admin.getByText("No files uploaded.")).toBeVisible();
});

test("a signed-in prospect cannot see or call the admin area", async ({ page, request }, info) => {
  const email = `nosy+${info.project.name}@example-co.com`;
  await prospectUploads(page, email, `Nosy Co ${info.project.name}`);
  await expect(page.getByText(`Signed in as ${email}`)).toBeVisible();

  const res = await page.goto("/admin");
  expect(res?.status()).toBe(404);

  const api = await page.request.post(`/api/admin/leads/${crypto.randomUUID()}/status`, {
    data: { status: "not_qualified" },
  });
  expect(api.status()).toBe(403);

  const anonymous = await request.post(`/api/admin/leads/${crypto.randomUUID()}/status`, { data: { status: "new" } });
  expect(anonymous.status()).toBe(401);
});

test("a prospect can delete their own snapshot", async ({ page }, info) => {
  const email = `delete+${info.project.name}@example-co.com`;
  await prospectUploads(page, email, `Delete Co ${info.project.name}`);
  const snapshotUrl = page.url();
  await page.getByRole("button", { name: "Delete file and snapshot" }).click();
  await expect(page.getByText(/cannot be undone/)).toBeVisible();
  await page.getByRole("button", { name: "Delete permanently" }).click();
  await expect(page).toHaveURL(/\/snapshots$/);
  await expect(page.getByText("No snapshots yet.")).toBeVisible();
  expect((await page.goto(snapshotUrl))?.status()).toBe(404);
});
