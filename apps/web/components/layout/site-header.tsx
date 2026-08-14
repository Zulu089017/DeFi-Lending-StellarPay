"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Menu, X } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { WalletConnect } from "@/components/wallet/wallet-connect";

const links = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/bridge", label: "Bridge" },
  { href: "/lend", label: "Lend" },
  { href: "/liquidations", label: "Liquidations" },
];

export function SiteHeader() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-40 w-full border-b border-border/40 bg-background/60 backdrop-blur supports-[backdrop-filter]:bg-background/40">
      <div className="container flex h-16 items-center justify-between">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2.5 text-lg font-semibold group">
            <span className="grid h-8 w-8 place-items-center rounded-lg bg-background/80 ring-1 ring-border/50 transition-shadow group-hover:shadow-lg group-hover:shadow-stellar/20">
              <img src="/logo.svg" alt="StellarPay" className="h-5 w-5" />
            </span>
            <span className="bg-gradient-to-r from-stellar to-polygon bg-clip-text text-transparent">StellarPay</span>
          </Link>
          <nav className="hidden gap-1 md:flex">
            {links.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm transition-colors hover:bg-accent/10 hover:text-foreground",
                  pathname === l.href ? "text-foreground bg-accent/10" : "text-muted-foreground",
                )}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>

        <div className="hidden items-center gap-3 md:flex">
          <WalletConnect />
          <Button asChild size="sm" variant="outline">
            <a href="https://github.com/Zulu089017/DeFi-Lending-Platform" target="_blank" rel="noreferrer">GitHub</a>
          </Button>
        </div>

        <button className="md:hidden" onClick={() => setOpen((v) => !v)}>
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>
      {open && (
        <div className="border-t border-border/40 p-4 md:hidden">
          <div className="flex flex-col gap-2">
            {links.map((l) => (
              <Link key={l.href} href={l.href} onClick={() => setOpen(false)} className="rounded-md px-3 py-2 text-sm hover:bg-accent/10">
                {l.label}
              </Link>
            ))}
            <WalletConnect />
          </div>
        </div>
      )}
    </header>
  );
}
