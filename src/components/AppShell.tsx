"use client";

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import {
  BookOpen,
  Compass,
  Flame,
  LogOut,
  PenTool,
  Search,
  Settings,
  User as UserIcon,
} from "lucide-react";
import { GlobalSearchModal } from "@/components/GlobalSearchModal";
import { OnboardingModal } from "@/components/OnboardingModal";
import { useSpix } from "@/components/SpixContext";
import { SpixWidget } from "@/components/SpixWidget";
import { ANNOUNCEMENT_VARIANTS } from "@/lib/announcement-ui";
import type { SystemSettings } from "@/lib/system-settings";

export function AppShell({ children }: { children: ReactNode }) {
  const { data: session, status } = useSession();
  const pathname = usePathname();
  const router = useRouter();
  const { setUserAiAndSpixEnabled } = useSpix();
  const [searchOpen, setSearchOpen] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [systemSettings, setSystemSettings] = useState<SystemSettings | null>(
    null
  );

  useEffect(() => {
    if (status === "unauthenticated") {
      router.replace("/login");
    }
  }, [status, router]);

  useEffect(() => {
    if (status !== "authenticated") return;
    let active = true;
    fetch("/api/system/health", { cache: "no-store" })
      .then(async (res) => {
        if (!active) return;
        if (res.status === 401) {
          void signOut({ callbackUrl: "/login" });
          return;
        }
        if (res.ok) {
          const data = (await res.json().catch(() => null)) as {
            settings?: SystemSettings;
          } | null;
          if (active && data?.settings) {
            setSystemSettings(data.settings);
            setUserAiAndSpixEnabled(data.settings.userAiAndSpixEnabled);
          }
        }
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [status, pathname, setUserAiAndSpixEnabled]);

  useEffect(() => {
    function handleSettingsEvent(e: Event) {
      const custom = e as CustomEvent<SystemSettings>;
      if (custom.detail) {
        setSystemSettings(custom.detail);
        setUserAiAndSpixEnabled(custom.detail.userAiAndSpixEnabled);
      }
    }
    window.addEventListener("ara-system-settings-updated", handleSettingsEvent);
    return () =>
      window.removeEventListener(
        "ara-system-settings-updated",
        handleSettingsEvent
      );
  }, [setUserAiAndSpixEnabled]);

  useEffect(() => {
    function handleShortcut(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
      } else if (e.key === "Escape") {
        setSearchOpen(false);
      }
    }
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => {
    if (status !== "authenticated" || !session?.user?.id) return;
    const storageKey = `ara_onboarding_seen_v1_${session.user.id}`;
    try {
      if (!window.localStorage.getItem(storageKey)) {
        setOnboardingOpen(true);
      }
    } catch {
      // Ignore storage access errors in restricted contexts
    }
  }, [status, session?.user?.id]);

  function handleDismissOnboarding() {
    if (session?.user?.id) {
      try {
        window.localStorage.setItem(
          `ara_onboarding_seen_v1_${session.user.id}`,
          "1"
        );
      } catch {
        // Ignore storage errors
      }
    }
    setOnboardingOpen(false);
  }

  if (status === "loading" || status === "unauthenticated") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-paper">
        <div className="border border-border bg-card px-8 py-6 text-center">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center bg-ink font-mono text-xs font-bold text-card">
            ARA
          </div>
          <p className="font-mono text-xs uppercase tracking-wider text-stone">
            CHARGEMENT DE L&apos;ESPACE DE TRAVAIL...
          </p>
        </div>
      </div>
    );
  }

  const user = session?.user;
  const isYearAdmin = user?.globalRole === "YEAR_ADMIN";

  const navItems = [
    {
      href: "/",
      label: "MES UE",
      icon: BookOpen,
      match: (p: string) => p === "/" || p.startsWith("/ue/"),
    },
    {
      href: "/revisions",
      label: "RÉVISIONS & STREAK",
      icon: Flame,
      match: (p: string) => p.startsWith("/revisions"),
    },
    {
      href: "/whiteboard",
      label: "MES TABLEAUX BLANCS",
      icon: PenTool,
      match: (p: string) => p.startsWith("/whiteboard"),
    },
    ...(isYearAdmin
      ? [
          {
            href: "/admin",
            label: "GOUVERNANCE",
            icon: Settings,
            match: (p: string) => p.startsWith("/admin"),
          },
        ]
      : []),
  ];

  return (
    <div className="flex min-h-screen flex-col bg-paper text-ink">
      {/* Top Bar */}
      <header className="border-b border-border bg-card">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-4 px-4 py-3 sm:px-6">
          {/* Left Identity */}
          <Link href="/" className="flex items-center gap-3">
            <div className="flex h-9 w-9 items-center justify-center border border-ink bg-ink font-mono text-[11px] font-bold tracking-wider text-card">
              ARA
            </div>
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-sm font-bold tracking-tight text-ink">
                ARA
              </span>
              <span className="font-mono text-xs uppercase tracking-wider text-stone">
                PROMO WORKSPACE
              </span>
              <span className="border border-border bg-paper px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-stone">
                ONIRIS · 100% LOCAL &amp; ÉCO-HÉBERGÉ
              </span>
            </div>
          </Link>

          {/* Right Controls */}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setOnboardingOpen(true)}
              className="inline-flex items-center gap-1.5 border border-border bg-paper px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-stone transition-colors hover:border-ink hover:text-ink"
              title="Découvrir ARA & nos engagements Oniris"
            >
              <Compass className="h-3.5 w-3.5 text-forest" />
              <span className="hidden md:inline">GUIDE ONIRIS</span>
            </button>

            <button
              type="button"
              onClick={() => setSearchOpen(true)}
              className="inline-flex items-center gap-2 border border-border bg-paper px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-stone transition-colors hover:border-ink hover:text-ink"
              title="Recherche globale (Ctrl+K)"
            >
              <Search className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">RECHERCHER</span>
              <span className="border border-border bg-card px-1 text-[9px] text-ink">
                CTRL+K
              </span>
            </button>

            <span className="border border-border bg-paper px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-ink">
              {isYearAdmin ? "[RESP. D'ANNÉE]" : "[ÉTUDIANT]"}
              {user?.classLevel ? ` · ${user.classLevel}` : ""}
            </span>

            {isYearAdmin && (
              <Link
                href="/admin"
                title="Administration & Gouvernance"
                className="inline-flex h-8 w-8 items-center justify-center border border-border bg-card text-ink transition-colors hover:bg-pinned"
              >
                <Settings className="h-4 w-4" />
              </Link>
            )}

            <div className="flex items-center gap-2 border border-border bg-paper px-2.5 py-1">
              <UserIcon className="h-3.5 w-3.5 text-stone" />
              <span className="font-mono text-[11px] uppercase tracking-wider text-ink">
                {user?.name}
              </span>
              <button
                type="button"
                onClick={() => signOut({ callbackUrl: "/login" })}
                title="Se déconnecter"
                className="ml-1 border-l border-border pl-2 text-stone transition-colors hover:text-carmine"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="border-t border-border bg-paper">
          <div className="mx-auto flex max-w-[1440px] items-center gap-1 overflow-x-auto px-4 sm:px-6">
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = item.match(pathname);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-3.5 py-2.5 font-mono text-xs uppercase tracking-wider transition-colors ${
                    active
                      ? "border-ink bg-card font-semibold text-ink"
                      : "border-transparent text-stone hover:text-ink"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{item.label}</span>
                </Link>
              );
            })}
          </div>
        </nav>
      </header>

      {/* Global Site Announcement Banner */}
      {systemSettings?.announcementEnabled &&
        systemSettings.announcementMessage.trim().length > 0 &&
        (() => {
          const variant =
            ANNOUNCEMENT_VARIANTS[systemSettings.announcementType] ||
            ANNOUNCEMENT_VARIANTS.INFO;
          const BannerIcon = variant.Icon;
          return (
            <div className="mx-auto w-full max-w-[1440px] px-4 pt-4 sm:px-6">
              <div
                role="status"
                className={`ara-animate-in flex flex-wrap items-center gap-3 border px-4 py-3 ${variant.containerClass}`}
                style={{ borderLeft: `4px solid ${variant.hex}` }}
              >
                <span
                  className={`inline-flex shrink-0 items-center gap-1.5 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${variant.badgeClass}`}
                >
                  <BannerIcon className="h-3 w-3" />
                  <span>{variant.badge}</span>
                </span>
                <p className="min-w-0 flex-1 whitespace-pre-wrap text-xs font-medium leading-relaxed text-ink">
                  {systemSettings.announcementMessage}
                </p>
              </div>
            </div>
          );
        })()}

      {/* Main Content */}
      <main className="mx-auto w-full max-w-[1440px] flex-1 px-4 py-6 sm:px-6">
        {children}
      </main>

      {/* Editorial Footer */}
      <footer className="mt-12 border-t border-border bg-card">
        <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-2 px-4 py-3 font-mono text-[10px] uppercase tracking-wider text-stone sm:px-6">
          <span>
            ARA ARCHIVE ACADÉMIQUE · INDEXATION LOCALE DES RESSOURCES
          </span>
          <span className="flex items-center gap-2 text-ink">
            <span className="inline-block h-2 w-2 bg-ink" />
            BASE DE DONNÉES POSTGRESQL + PGVECTOR ACTIVE
          </span>
        </div>
      </footer>

      {/* Global Search Modal (Ctrl+K) */}
      <GlobalSearchModal
        isOpen={searchOpen}
        onClose={() => setSearchOpen(false)}
      />

      {/* First-Login Oniris Onboarding Modal */}
      <OnboardingModal
        isOpen={onboardingOpen}
        userName={user?.name}
        classLevel={user?.classLevel}
        onComplete={handleDismissOnboarding}
        onClose={handleDismissOnboarding}
      />

      {/* Floating Context-Aware Spix Square */}
      <SpixWidget />
    </div>
  );
}
