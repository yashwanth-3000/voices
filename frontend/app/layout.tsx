import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ContentHub — Marketplace for Writing Styles",
  description:
    "ContentHub is a marketplace where creators monetize their writing style and teams generate content with authentic voices.",
  icons: [{ rel: "icon", url: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Cdefs%3E%3ClinearGradient id='g' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop stop-color='%236EE7FF'/%3E%3Cstop offset='1' stop-color='%23A78BFA'/%3E%3C/linearGradient%3E%3C/defs%3E%3Cpath fill='url(%23g)' d='M14 10h26a10 10 0 0 1 10 10v24a10 10 0 0 1-10 10H14A10 10 0 0 1 4 44V20A10 10 0 0 1 14 10Z'/%3E%3Cpath fill='rgba(0,0,0,0.35)' d='M18 22h22a3 3 0 0 1 0 6H18a3 3 0 0 1 0-6Zm0 14h28a3 3 0 0 1 0 6H18a3 3 0 0 1 0-6Z'/%3E%3C/svg%3E" }],
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

