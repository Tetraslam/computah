import { Computah } from "@tetraslam13/computah";
import type { Metadata, Viewport } from "next";
import { Desk } from "@/components/desk";
import { stack } from "@/lib/source";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "computah", template: "%s · computah" },
  description:
    "An improvements box for your app. Type what should change, and a coding agent you already have changes the code while you watch.",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  const cards = stack().map((card) => ({ url: card.url, title: card.data.title, description: card.data.description }));
  return (
    <html lang="en">
      <body>
        <Desk cards={cards} />
        {children}
        {/* This site is a computah app: the box is here for its owner and trusted people, and never for visitors. */}
        <Computah />
      </body>
    </html>
  );
}
