import { expect, test, type Page } from "@playwright/test";

/**
 * The first ten minutes, in a browser, against the mock.
 *
 * Sign in, be met by the setup wizard, point it at the mock, paste the key,
 * see the Home page with numbers on it. This is the test 0.5.0 did not have:
 * three features shipped with routes and no way to reach them, and every
 * unit test was green. Serial, because the second half depends on the
 * server the first half added.
 */

const MOCK = "ws://127.0.0.1:18443";
const shots = process.env.SCREENSHOTS === "1";

test.describe.configure({ mode: "serial" });

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByPlaceholder("Username").fill("admin");
  await page.getByPlaceholder("Password").fill("e2e-password-1");
  await page.getByRole("button", { name: "Sign in" }).click();
}

test("a new console walks through setup to a working Home page", async ({ page }) => {
  await signIn(page);

  await expect(page.getByRole("heading", { name: "Where is your TrueNAS?" })).toBeVisible();
  await page.getByPlaceholder("192.168.1.10").fill(MOCK);
  await page.getByRole("button", { name: "Next" }).click();

  // The mock speaks plain ws, so there is no certificate to pin. The wizard
  // says so and offers the way on.
  await expect(page.getByRole("heading", { name: "Trust its certificate" })).toBeVisible();
  await page.getByRole("button", { name: "Continue without pinning" }).click();

  await expect(page.getByRole("heading", { name: "An API key" })).toBeVisible();
  await page.getByPlaceholder("1-…").fill("1-mock");
  await page.getByRole("button", { name: "Test" }).click();
  await expect(page.getByText(/Reached demo-nas running TrueNAS/)).toBeVisible();
  await page.getByRole("button", { name: "Next" }).click();

  await expect(page.getByRole("heading", { name: "Moving and deleting files" })).toBeVisible();
  await page.getByRole("button", { name: "Skip for now" }).click();

  await expect(page.getByRole("heading", { name: "Ready" })).toBeVisible();
  await page.getByRole("button", { name: "Open the console" }).click();

  // Home, with the mock's numbers on it.
  await expect(page.getByRole("button", { name: "demo-nas" })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("tank", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/Everything is healthy/)).toBeVisible();
});

test("every page renders against the mock", async ({ page }) => {
  await signIn(page);
  await expect(page.getByRole("button", { name: "demo-nas" })).toBeVisible({ timeout: 15_000 });
  // Long enough for the sparklines to have a few points.
  await page.waitForTimeout(shots ? 4000 : 500);
  if (shots) await page.screenshot({ path: "docs/screenshots/home.png" });

  await page.goto("/#/drives");
  await expect(page.getByRole("heading", { name: "Drive array map" })).toBeVisible();
  await expect(page.getByText("sdc", { exact: true })).toBeVisible();
  if (shots) await page.screenshot({ path: "docs/screenshots/drives.png" });

  await page.goto("/#/files");
  await expect(page.getByRole("heading", { name: "My files" })).toBeVisible();
  await page.getByText("tank", { exact: true }).click();
  await page.getByText("media", { exact: true }).click();
  await expect(page.getByText("library-index.json")).toBeVisible();
  if (shots) await page.screenshot({ path: "docs/screenshots/files.png" });

  await page.goto("/#/apps");
  await expect(page.getByRole("heading", { name: "Apps" })).toBeVisible();
  await expect(page.getByText("nextcloud", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Logs" }).first()).toBeVisible();
  if (shots) await page.screenshot({ path: "docs/screenshots/apps.png" });

  await page.goto("/#/people");
  await page.getByRole("button", { name: "Groups" }).click();
  await expect(page.getByText("family", { exact: true })).toBeVisible();
  if (shots) await page.screenshot({ path: "docs/screenshots/groups.png" });

  await page.goto("/#/safety");
  await expect(page.getByRole("heading", { name: "Backups and checks" })).toBeVisible();
  await expect(page.getByText("Family photos to Backblaze")).toBeVisible();
  await expect(page.getByText("tank/private")).toBeVisible();
  if (shots) await page.screenshot({ path: "docs/screenshots/safety.png" });

  await page.goto("/#/sharing");
  await expect(page.getByText("Family", { exact: true })).toBeVisible();
  if (shots) await page.screenshot({ path: "docs/screenshots/shares.png" });
});
