import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fest Growth Analytics",
  description: "Plan, measure and grow verified fest attendance.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
