import type { Metadata } from "next";
import Link from "next/link";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";

export const metadata: Metadata = {
  title: "LoopBench — harness evolution",
  description: "A measured history of changes to your agent harness.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className={`${GeistSans.variable} ${GeistMono.variable}`}>
      <body>
        <header className="topbar">
          <div className="topbar-in">
            <Link className="brand" href="/">
              <span className="brand-mark" aria-hidden="true" />
              LoopBench
            </Link>
            <nav className="topnav" aria-label="Main navigation">
              <Link href="/">Trees</Link>
              <Link href="/experiments">My experiments</Link>
              <Link href="/experiments/new">New experiment</Link>
              <Link href="/setup">Connect Nebius</Link>
              <Link href="/adapters">Adapters</Link>
              <a
                href="https://github.com/Avoisavo/ethonline2026"
                target="_blank"
                rel="noreferrer"
              >
                Petri reference ↗
              </a>
            </nav>
            <span className="header-note">
              Harness evolution · measured results
            </span>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
