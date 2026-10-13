import { e2eFixturesEnabled } from "@diagram-mapper/config";
import { notFound } from "next/navigation";
import { ExplanationView } from "../../../components/explanation/ExplanationView.tsx";
import { INJECTION_EXPLANATION } from "./injection-fixture.ts";

/**
 * Test-only page for the F-06 rendering oracle (apps/web-e2e/injection.e2e.ts). It renders a
 * hostile explanation through the real component. It returns 404 unless the server was
 * started with DM_E2E_FIXTURES=1, which only the e2e harness does; the deployed preview and
 * production never set it, and the header suite asserts that the page is absent there.
 */
export default function InjectionFixturePage() {
  if (!e2eFixturesEnabled()) notFound();
  return (
    <main>
      <h1>Explanation rendering fixture</h1>
      <ExplanationView explanation={INJECTION_EXPLANATION} />
    </main>
  );
}
