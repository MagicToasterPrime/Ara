"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  ArrowUpRight,
  BookOpen,
  MessageSquare,
  MoreVertical,
  PenTool,
  Plus,
  Search,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";

interface UEItem {
  id: string;
  code: string;
  title: string;
  description: string;
  semester: string;
  accentColor: string;
  order: number;
  updatedAt: string;
  roles: Array<{
    id: string;
    user: { id: string; name: string; email: string };
  }>;
  chapterCount: number;
  officialCount: number;
  noteCount: number;
  pinnedNoteCount: number;
  channels: Array<{ id: string; name: string; type: string }>;
  whiteboards: Array<{ id: string; title: string; updatedAt: string }>;
}

function getMonogram(code: string, title: string): string {
  const letters = title
    .replace(/[^a-zA-ZÀ-ÿ\s]/g, "")
    .trim()
    .slice(0, 2)
    .toUpperCase();
  return letters || code.slice(0, 2).toUpperCase();
}

export default function HomePage() {
  const { data: session } = useSession();
  const [ues, setUes] = useState<UEItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [semesterFilter, setSemesterFilter] = useState("ALL");
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function loadUEs() {
      try {
        const res = await fetch("/api/ues", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { ues?: UEItem[] };
        if (active && data.ues) {
          setUes(data.ues);
        }
      } finally {
        if (active) setLoading(false);
      }
    }
    loadUEs();
    return () => {
      active = false;
    };
  }, []);

  const semesters = useMemo(() => {
    const set = new Set<string>();
    for (const ue of ues) {
      if (ue.semester) set.add(ue.semester);
    }
    return Array.from(set).sort();
  }, [ues]);

  const filteredUes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ues.filter((ue) => {
      if (semesterFilter !== "ALL" && ue.semester !== semesterFilter) {
        return false;
      }
      if (!q) return true;
      return (
        ue.code.toLowerCase().includes(q) ||
        ue.title.toLowerCase().includes(q) ||
        ue.description.toLowerCase().includes(q)
      );
    });
  }, [ues, search, semesterFilter]);

  const isYearAdmin = session?.user?.globalRole === "YEAR_ADMIN";

  return (
    <AppShell>
      {/* Toolbar: Search + Semester Filter */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-ink">
            UNITÉS D&apos;ENSEIGNEMENT
          </h1>
          <p className="font-mono text-[11px] uppercase tracking-wider text-stone">
            [ {ues.length} MATIÈRES ENREGISTRÉES · ACCÈS DIRECT AUX COURS &amp; NOTES ]
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Rechercher un cours ou une UE..."
              className="w-64 border border-border bg-card py-2 pl-9 pr-3 text-sm text-ink placeholder:text-stone focus:border-ink focus:outline-none"
            />
          </div>

          <select
            value={semesterFilter}
            onChange={(e) => setSemesterFilter(e.target.value)}
            className="border border-border bg-card px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink focus:border-ink focus:outline-none"
          >
            <option value="ALL">TRI : TOUS SEMESTRES</option>
            {semesters.map((sem) => (
              <option key={sem} value={sem}>
                TRI : SEMESTRE {sem}
              </option>
            ))}
          </select>

          {isYearAdmin && (
            <Link
              href="/admin"
              className="inline-flex items-center gap-1.5 border border-ink bg-ink px-3.5 py-2 font-mono text-xs uppercase tracking-wider text-card transition-colors hover:bg-ink/90"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>GÉRER LES UE</span>
            </Link>
          )}
        </div>
      </div>

      {/* Content */}
      {loading ? (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((idx) => (
            <div
              key={idx}
              className="h-64 animate-pulse border border-border bg-card p-5"
            />
          ))}
        </div>
      ) : ues.length === 0 ? (
        <div className="border border-border bg-card p-10 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center border border-border bg-paper">
            <BookOpen className="h-5 w-5 text-stone" />
          </div>
          <h2 className="text-base font-bold uppercase tracking-tight text-ink">
            AUCUNE UNITÉ D&apos;ENSEIGNEMENT CONFIGURÉE
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm text-stone">
            La base de données PostgreSQL est active mais aucune matière n&apos;a
            encore été créée pour cette promotion.
          </p>
          {isYearAdmin ? (
            <Link
              href="/admin"
              className="mt-5 inline-flex items-center gap-2 border border-ink bg-ink px-5 py-2.5 font-mono text-xs uppercase tracking-wider text-card transition-colors hover:bg-ink/90"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>CRÉER LA PREMIÈRE UE</span>
            </Link>
          ) : (
            <p className="mt-4 font-mono text-xs uppercase tracking-wider text-stone">
              CONTACTEZ LE RESPONSABLE D&apos;ANNÉE POUR INITIALISER LES MATIÈRES.
            </p>
          )}
        </div>
      ) : filteredUes.length === 0 ? (
        <div className="border border-border bg-card p-8 text-center">
          <p className="font-mono text-xs uppercase tracking-wider text-stone">
            AUCUNE UE NE CORRESPOND À VOTRE RECHERCHE &quot;{search}&quot;.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {filteredUes.map((ue) => {
            const managers =
              ue.roles.length > 0
                ? ue.roles.map((r) => r.user.name).join(", ")
                : "NON ASSIGNÉ";
            const monogram = getMonogram(ue.code, ue.title);
            const updatedStr = new Date(ue.updatedAt).toLocaleDateString(
              "fr-FR",
              { day: "2-digit", month: "short" }
            );
            const primaryChannel = ue.channels[0];

            return (
              <article
                key={ue.id}
                className="relative flex flex-col justify-between border border-border bg-card p-5"
                style={{ borderTop: `3px solid ${ue.accentColor || "#D99B26"}` }}
              >
                <div>
                  {/* Top Monospace Line */}
                  <div className="mb-4 flex items-center justify-between gap-2 font-mono text-[11px] uppercase tracking-wider text-stone">
                    <span className="font-semibold text-ink">
                      {ue.code} · {ue.semester}
                    </span>
                    <span className="inline-flex items-center gap-1">
                      {ue.officialCount} PDF · {ue.noteCount} NOTES
                      <ArrowUpRight className="h-3 w-3" />
                    </span>
                  </div>

                  {/* Monogram + Title + Resp Badge */}
                  <div className="mb-3 flex items-start gap-3">
                    <div
                      className="flex h-10 w-10 shrink-0 items-center justify-center border border-border bg-paper font-mono text-xs font-bold uppercase"
                      style={{ color: ue.accentColor || "#1A1A1A" }}
                    >
                      {monogram}
                    </div>
                    <div className="min-w-0">
                      <h2 className="text-base font-bold uppercase leading-snug tracking-tight text-ink">
                        {ue.title}
                      </h2>
                      <span className="mt-1 inline-block bg-badge-bg px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-badge-text">
                        RESP: {managers}
                      </span>
                    </div>
                  </div>

                  {/* Description */}
                  <p className="mb-5 line-clamp-3 text-sm leading-relaxed text-stone">
                    {ue.description ||
                      "Espace de cours officiels, fiches étudiantes vérifiées et ressources collaboratives."}
                  </p>
                </div>

                <div>
                  {/* Technical Metadata Strip */}
                  <div className="mb-3 grid grid-cols-3 gap-1.5 border-t border-border pt-3 font-mono text-[10px] uppercase tracking-wider text-stone">
                    <div className="border border-border bg-paper px-2 py-1">
                      CHAPITRES : <span className="text-ink">{ue.chapterCount}</span>
                    </div>
                    <div className="border border-border bg-paper px-2 py-1">
                      VALIDÉS : <span className="text-ink">{ue.pinnedNoteCount}</span>
                    </div>
                    <div className="border border-border bg-paper px-2 py-1">
                      MÀJ : <span className="text-ink">{updatedStr}</span>
                    </div>
                  </div>

                  {/* Action Row */}
                  <div className="relative flex items-stretch gap-1.5">
                    <Link
                      href={`/ue/${ue.id}`}
                      className="flex flex-1 items-center justify-center border border-border bg-paper px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider text-ink transition-colors hover:border-ink hover:bg-pinned"
                    >
                      OUVRIR L&apos;UE
                    </Link>

                    <button
                      type="button"
                      onClick={() =>
                        setOpenMenuId(openMenuId === ue.id ? null : ue.id)
                      }
                      aria-label="Actions rapides"
                      className="flex w-10 items-center justify-center border border-border bg-paper text-ink transition-colors hover:border-ink hover:bg-pinned"
                    >
                      <MoreVertical className="h-4 w-4" />
                    </button>

                    {openMenuId === ue.id && (
                      <div className="absolute bottom-12 right-0 z-20 w-56 border border-ink bg-card p-1">
                        {primaryChannel && (
                          <Link
                            href={`/chat?channelId=${primaryChannel.id}`}
                            className="flex items-center gap-2 px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-ink hover:bg-pinned"
                          >
                            <MessageSquare className="h-3.5 w-3.5" />
                            <span>CANAL {primaryChannel.name}</span>
                          </Link>
                        )}
                        <Link
                          href={`/whiteboard?ueId=${ue.id}`}
                          className="flex items-center gap-2 px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-ink hover:bg-pinned"
                        >
                          <PenTool className="h-3.5 w-3.5" />
                          <span>TABLEAUX BLANCS ({ue.whiteboards.length})</span>
                        </Link>
                      </div>
                    )}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </AppShell>
  );
}
