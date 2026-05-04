import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GEO Ops",
  description: "GEO content account operations dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
