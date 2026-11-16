import type { Metadata } from "next";
import { Computah } from "computah";
import "./globals.css";

export const metadata: Metadata = {
  title: "computah",
  description: "A card you can change by asking.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en">
      <body>
        {children}
        <Computah defaultOpen />
      </body>
    </html>
  );
}
