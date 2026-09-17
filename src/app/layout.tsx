import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "PactAgent",
  description: "Autonomous agents contracting and settling over open Bitcoin protocols.",
  icons: {
    icon: [{ url: "/pactagent-mark.svg", type: "image/svg+xml" }],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
