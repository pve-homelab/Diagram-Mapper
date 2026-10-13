import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

/**
 * TEST-STRATEGY section 8: zero serious or critical axe violations on every primary view.
 * Moderate findings are recorded as test annotations for triage, not failed on.
 */
const VIEWS = [
  { name: "home", path: "/", deployed: true },
  { name: "explanation (hostile fixture)", path: "/e2e/explanation", deployed: false },
];

for (const view of VIEWS) {
  test(`axe: ${view.name}`, { tag: view.deployed ? "@deployed" : [] }, async ({ page }) => {
    await page.goto(view.path);
    await page.waitForLoadState("networkidle");
    const { violations } = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
    for (const v of violations.filter((x) => !blocking.includes(x))) {
      test.info().annotations.push({
        type: `axe ${v.impact}`,
        description: `${v.id} (${v.nodes.length}) ${v.helpUrl}`,
      });
    }
    expect(
      blocking.map((v) => `${v.impact} ${v.id}: ${v.nodes.map((n) => n.target).join(", ")}`),
    ).toEqual([]);
  });
}
