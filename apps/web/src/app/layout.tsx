import type { Metadata, Viewport } from "next";
import { AppProvider } from "@/views/proviso/shared";
import "./globals.css";
import "./workspace.css";
import "./product.css";
import "./refinement.css";
export const metadata: Metadata = {
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL || "http://localhost:3000",
  ),
  title: {
    default: "Proviso — Write the call. Seal it.",
    template: "%s · Proviso",
  },
  description:
    "A new structure for market conviction. Explore Proviso’s thesis workspace, Proof of Call, Fair Copy, and account controls.",
  openGraph: {
    title: "Proviso — Write the call. Seal it.",
    description: "Your thesis. Your rules. Your record.",
    images: [{ url: "/assets/banner.png", width: 1500, height: 500 }],
  },
  icons: { icon: "/icon.svg" },
};
export const viewport: Viewport = {
  themeColor: "#0b0b0b",
  width: "device-width",
  initialScale: 1,
};
export default function Layout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <AppProvider>{children}</AppProvider>
      </body>
    </html>
  );
}
