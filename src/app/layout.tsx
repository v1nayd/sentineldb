import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: { default: "SentinelDB", template: "%s · SentinelDB" },
  description: "Relational–vector hybrid incident intelligence (synthetic data only).",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
