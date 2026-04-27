import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Voices Test Console",
  description: "Local test console for the Voices 0G agent workflow"
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
