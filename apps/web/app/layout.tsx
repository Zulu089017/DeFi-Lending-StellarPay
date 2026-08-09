import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Inter } from "next/font/google";
import { Providers } from "@/components/providers";
import { SiteHeader } from "@/components/layout/site-header";
import { Toaster } from "@/components/ui/toaster";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });

export const metadata: Metadata = {
  metadataBase: new URL("https://stellar-payment-gateway.xyz"),
  title: {
    default: "StellarPay — Cross-Chain Lending on Stellar",
    template: "%s | StellarPay",
  },
  description:
    "Wrap tokens from any chain and lend on Stellar. Real-time cross-chain settlement, automated liquidations, sub-cent fees, 5-second finality.",
  icons: { icon: "/favicon.svg" },
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "StellarPay",
    title: "StellarPay — Cross-Chain Lending on Stellar",
    description:
      "The fastest way to lend and borrow across chains. Sub-5-second finality on Stellar. Wrap, supply, borrow, earn.",
    images: [
      {
        url: "/og-image.svg",
        width: 1200,
        height: 630,
        alt: "StellarPay — Cross-chain lending settled on Stellar",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "StellarPay — Cross-Chain Lending on Stellar",
    description:
      "Wrap tokens from any chain and lend on Stellar. Sub-5s finality, sub-cent fees.",
    images: ["/twitter-card.svg"],
    creator: "@stellar_pay",
  },
  other: {
    "fc:frame": "vNext",
    "fc:frame:image": "/og-image.svg",
  },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className={`${inter.variable} font-sans antialiased min-h-screen`}>
        <Providers>
          <div className="relative flex min-h-screen flex-col">
            <SiteHeader />
            <main className="flex-1">{children}</main>
            <footer className="border-t border-border/40 py-8 text-sm text-muted-foreground">
              <div className="container flex flex-col items-center gap-2 sm:flex-row sm:justify-between">
                <p>© 2026 StellarPay. Built on Stellar.</p>
                <p>
                  Powered by Soroban · Horizon ·{" "}
                  <a className="hover:text-primary" href="https://github.com/Zulu089017/DeFi-Lending-Platform">GitHub</a>
                </p>
              </div>
            </footer>
          </div>
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
