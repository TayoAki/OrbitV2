import type { Metadata } from "next";
import "./globals.css";
import { StoreProvider } from "@/lib/react";
import { Shell } from "@/components/Shell";

export const metadata: Metadata = {
  title: "Acme — agent runs",
  description: "Supervise parallel AI coding-agent runs: triage, review, approve, merge.",
};

// Applies the saved / preferred theme before first paint to avoid a flash.
const themeBoot = `(function(){try{var t=localStorage.getItem('acme-theme');if(!t){t=window.matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light';}document.documentElement.setAttribute('data-theme',t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <script dangerouslySetInnerHTML={{ __html: themeBoot }} />
        <StoreProvider>
          <Shell>{children}</Shell>
        </StoreProvider>
      </body>
    </html>
  );
}
