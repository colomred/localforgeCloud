import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "__NAME__",
  description: "Built with LocalForge",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
