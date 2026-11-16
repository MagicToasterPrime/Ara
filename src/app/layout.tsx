import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { Providers } from "@/components/Providers";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ARA — Plateforme Collaborative Académique",
  description:
    "Plateforme collaborative auto-hébergée pour promotion d'étudiants : UE, PDF, Spix IA, Chat & Tableaux blancs.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="fr" className={`${inter.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-screen bg-paper font-sans text-ink antialiased selection:bg-badge-bg selection:text-badge-text">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
