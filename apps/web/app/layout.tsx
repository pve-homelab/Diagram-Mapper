import type { ReactNode } from "react";

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
