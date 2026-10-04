import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Disputes", template: "%s · Disputes" },
  description:
    "Investigate disputed invoices with deterministic recalculation and an evidence-grounded AI agent.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
};

export const dynamic = "force-dynamic";

/** Which agent will answer, read from the same env the agent uses. */
function agentLabel(): { label: string; live: boolean } {
  const mode = (process.env.AGENT_PROVIDER ?? "auto").toLowerCase();
  const hasKey = Boolean(process.env.GEMINI_API_KEY?.trim());
  if (mode === "mock" || !hasKey) return { label: "Mock agent", live: false };
  return { label: process.env.GEMINI_MODEL?.trim() || "gemini-3.6-flash", live: true };
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const agent = agentLabel();
  return (
    <html lang="en">
      <body>
        <header className="nav">
          <div className="inner">
            <Link href="/" className="brand">
              <span className="logo" aria-hidden="true">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 2.5H7a2 2 0 00-2 2v15a2 2 0 002 2h10a2 2 0 002-2v-12z" />
                  <path d="M9 13.5l2 2 4-4" />
                </svg>
              </span>
              Disputes
            </Link>
            <span className="engine-pill" title="Agent that interprets the evidence. All money math is deterministic.">
              <span className={agent.live ? "dot" : "dot mock"} />
              {agent.label}
            </span>
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
