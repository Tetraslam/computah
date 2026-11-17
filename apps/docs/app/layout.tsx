import { Computah } from "@tetraslam13/computah";
import type { Metadata, Viewport } from "next";
import { Desk } from "@/components/desk";
import { stack } from "@/lib/source";
import "./globals.css";

export const metadata: Metadata = {
  metadataBase: new URL("https://computah.sh"),
  title: { default: "computah", template: "%s · computah" },
  // What a link to this site looks like when it's pasted somewhere.
  openGraph: {
    siteName: "computah",
    type: "website",
    images: [{ url: "/preview.png", width: 1200, height: 630, alt: "computah: make this app better" }],
  },
  twitter: { card: "summary_large_image", creator: "@tetraslam", images: ["/preview.png"] },
  description:
    "a little window you put in your app. you type what should be different and an agent you already have edits the code while you watch",
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
