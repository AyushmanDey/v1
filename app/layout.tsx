import type { Metadata } from "next";
import { Fraunces, Poppins } from "next/font/google";
import Script from "next/script";
import { ThemeToggle } from "@/components/theme-toggle";
import "./globals.css";

const poppins = Poppins({ variable: "--font-poppins", subsets: ["latin"], weight: ["400", "500", "600", "700"] });
const fraunces = Fraunces({ variable: "--font-fraunces", subsets: ["latin"], weight: ["400", "500", "600"] });

export const metadata: Metadata = {
  title: "NEXIS Campus AI",
  description: "Your campus learning assistant, grounded in course materials.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${poppins.variable} ${fraunces.variable} h-full antialiased`}>
      <body className="min-h-full">
        <Script
          id="nexis-theme-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `try { if (localStorage.getItem("nexis-theme") === "dark") document.documentElement.classList.add("dark"); } catch {}`,
          }}
        />
        <ThemeToggle />
        {children}
      </body>
    </html>
  );
}
