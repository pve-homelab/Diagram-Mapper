import type { ReactNode } from "react";

// The CSP nonce is per request (middleware.ts, threat model F-14). Next.js can only stamp it
// on its scripts when the page is rendered per request; a statically prerendered page would
// ship nonce-less scripts that the CSP then blocks.
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Diagram Mapper",
  description: "Interactive, explainable diagrams of your Terraform.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
