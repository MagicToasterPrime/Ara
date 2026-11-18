"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  Archive,
  ArrowUpRight,
  BookOpen,
  Flame,
  MessageSquare,
  MoreVertical,
  PenTool,
  Plus,
  Search,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useSpix } from "@/components/SpixContext";
import {
  CLASS_LEVELS,
  formatExamBadge,
  type ClassLevel,
} from "@/lib/class-levels";

interface UEItem {
  id: string;
  code: string;
  title: string;
  description: string;
  semester: string;
  classLevel?: ClassLevel;
  examType?: string;
  examDate?: string | null;
  coeff?: number;
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
  const { setPageContext } = useSpix();
  const [ues, setUes] = useState<UEItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [semesterFilter, setSemesterFilter] = useState("ALL");
  const [classFilter, setClassFilter] = useState<string>("MY");
  const [showAllArchives, setShowAllArchives] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [revisionSummary, setRevisionSummary] = useState<{
    revisionEnabled: boolean;
    currentStreak: number;
    completedToday: boolean;
  } | null>(null);

  const userClassLevel = (session?.user?.classLevel || "VET2").toUpperCase();

  useEffect(() => {
    setPageContext({ mode: "GLOBAL" });
  }, [setPageContext]);

  useEffect(() => {
    let active = true;
    async function loadUEs() {
      try {
        const [ueRes, revRes] = await Promise.all([
          fetch("/api/ues", { cache: "no-store" }),
          fetch("/api/revisions", { cache: "no-store" }),
        ]);
        if (ueRes.ok) {
          const data = (await ueRes.json()) as { ues?: UEItem[] };
          if (active && data.ues) {
            setUes(data.ues);
          }
        }
        if (revRes.ok) {
          const revData = (await revRes.json()) as {
            userState?: {
              revisionEnabled: boolean;
              currentStreak: number;
              completedToday: boolean;
            };
          };
          if (active && revData.userState) {
            setRevisionSummary(revData.userState);
          }
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

  const effectiveClassTarget =
    classFilter === "MY" ? userClassLevel : classFilter;

  const filteredUes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ues.filter((ue) => {
      const ueCls = (ue.classLevel || "VET2").toUpperCase();
      if (effectiveClassTarget !== "ALL" && ueCls !== effectiveClassTarget) {
        return false;
      }
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
  }, [ues, search, semesterFilter, effectiveClassTarget]);

  const archiveUes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return ues.filter((ue) => {
      const ueCls = (ue.classLevel || "VET2").toUpperCase();
      if (ueCls === userClassLevel) return false;
      if (
        effectiveClassTarget !== "ALL" &&
        effectiveClassTarget !== userClassLevel &&
        ueCls === effectiveClassTarget
      ) {
        return false;
      }
      if (!q) return true;
      return (
        ue.code.toLowerCase().includes(q) ||
        ue.title.toLowerCase().includes(q) ||
        ue.description.toLowerCase().includes(q) ||
        ueCls.toLowerCase().includes(q)
      );
    });
  }, [ues, search, userClassLevel, effectiveClassTarget]);

  const isYearAdmin = session?.user?.globalRole === "YEAR_ADMIN";
  const visibleArchives = showAllArchives ? archiveUes : archiveUes.slice(0, 4);

  return (
    <AppShell>
      {/* Toolbar: Search + Class Filter + Semester Filter */}
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3 border-b border-border pb-4">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-ink">
            UNITÉS D&apos;ENSEIGNEMENT
          </h1>
          <p className="font-mono text-[11px] uppercase tracking-wider text-stone">
            [ {filteredUes.length} MATIÈRES AFFICHÉES · PROMO {userClassLevel} ·
            CTRL+K RECHERCHE PDF ]
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Filtrer une UE..."
              className="w-52 border border-border bg-card py-2 pl-9 pr-3 text-sm text-ink placeholder:text-stone focus:border-ink focus:outline-none"
            />
          </div>

          <select
            value={classFilter}
            onChange={(e) => setClassFilter(e.target.value)}
            className="border border-border bg-card px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink focus:border-ink focus:outline-none"
          >
            <option value="MY">MA CLASSE : {userClassLevel}</option>
            <option value="ALL">TOUTES LES CLASSES</option>
            {CLASS_LEVELS.map((lvl) => (
              <option key={lvl} value={lvl}>
                CLASSE : {lvl}
              </option>
            ))}
          </select>

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

      {/* Daily Revision & Streak Strip */}
      {revisionSummary && (
        <div
          className="mb-6 flex flex-wrap items-center justify-between gap-3 border border-border bg-card px-4 py-3"
          style={{
            borderLeft: `3px solid ${
              revisionSummary.revisionEnabled ? "#D99B26" : "#DCDAD3"
            }`,
          }}
        >
          <div className="flex flex-wrap items-center gap-3">
            <Flame
              className={`h-4 w-4 ${
                revisionSummary.revisionEnabled ? "text-amber" : "text-stone"
              }`}
            />
            <span className="font-mono text-xs font-bold uppercase tracking-wider text-ink">
              {revisionSummary.revisionEnabled
                ? `STREAK : ${revisionSummary.currentStreak} JOURS`
                : "RÉVISIONS JOURNALIÈRES DÉSACTIVÉES"}
            </span>
            <span className="font-mono text-[11px] uppercase tracking-wider text-stone">
              {revisionSummary.revisionEnabled
                ? revisionSummary.completedToday
                  ? "· SÉANCE DU JOUR VALIDÉE ✓"
                  : "· QUIZ IA QUOTIDIEN · UE & COURS ALÉATOIRES (QCU, QCM, QROC, FLASHCARDS)"
                : "· ACTIVEZ LE QUIZ IA QUOTIDIEN (QCU, QCM, QROC, FLASHCARDS)"}
            </span>
          </div>

          <Link
            href="/revisions"
            className="inline-flex items-center gap-1.5 border border-ink bg-ink px-3.5 py-1.5 font-mono text-[11px] uppercase tracking-wider text-card hover:bg-ink/90"
          >
            <span>
              {revisionSummary.revisionEnabled
                ? revisionSummary.completedToday
                  ? "CLASSEMENT & CARNET D'ERREURS"
                  : "LANCER LA SÉANCE DU JOUR"
                : "ACTIVER LES RÉVISIONS"}
            </span>
            <ArrowUpRight className="h-3.5 w-3.5" />
          </Link>
        </div>
      )}

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
          <p className="font-mono text-xs uppercase tracking-wider text-ink">
            AUCUNE UE TROUVÉE POUR {effectiveClassTarget}
            {search ? ` AVEC "${search}"` : ""}.
          </p>
          <button
            type="button"
            onClick={() => {
              setClassFilter("ALL");
              setSemesterFilter("ALL");
              setSearch("");
            }}
            className="mt-4 border border-ink bg-paper px-4 py-2 font-mono text-xs uppercase tracking-wider text-ink hover:bg-pinned"
          >
            AFFICHER TOUTES LES PROMOTIONS ({ues.length})
          </button>
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
            const exam = formatExamBadge(ue.examType, ue.examDate);

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
                      {ue.code} · {ue.semester} · {ue.classLevel || "VET2"}
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
                      <div className="mt-1 flex flex-wrap items-center gap-1.5">
                        <span className="inline-block bg-badge-bg px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-badge-text">
                          RESP: {managers}
                        </span>
                        {exam.countdownLabel && (
                          <span
                            className={`border px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider ${
                              exam.daysRemaining !== null &&
                              exam.daysRemaining >= 0 &&
                              exam.daysRemaining <= 14
                                ? "border-carmine/40 bg-carmine/10 text-carmine"
                                : "border-border bg-paper text-ink"
                            }`}
                          >
                            {exam.countdownLabel}
                          </span>
                        )}
                      </div>
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
                    <div className="truncate border border-border bg-paper px-2 py-1">
                      [{exam.typeLabel.slice(0, 7)} : {exam.dateLabel}]
                    </div>
                    <div className="border border-border bg-paper px-2 py-1">
                      [COEFF : <span className="text-ink">{ue.coeff ?? 4}</span>]
                    </div>
                    <div className="truncate border border-border bg-paper px-2 py-1">
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
                        <Link
                          href={`/ue/${ue.id}?tab=discussion`}
                          className="flex items-center gap-2 px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-ink hover:bg-pinned"
                        >
                          <MessageSquare className="h-3.5 w-3.5" />
                          <span>
                            DISCUSSION{" "}
                            {primaryChannel ? `(${primaryChannel.name})` : ""}
                          </span>
                        </Link>
                        <Link
                          href={`/ue/${ue.id}?tab=whiteboards`}
                          className="flex items-center gap-2 px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-ink hover:bg-pinned"
                        >
                          <PenTool className="h-3.5 w-3.5" />
                          <span>TABLEAUX BLANCS ({ue.whiteboards.length})</span>
                        </Link>
                        <Link
                          href={`/ue/${ue.id}?tab=exam`}
                          className="flex items-center gap-2 px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-ink hover:bg-pinned"
                        >
                          <BookOpen className="h-3.5 w-3.5" />
                          <span>PARTIEL BLANC</span>
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

      {/* Section 02: Archives & Autres Promotions */}
      {!loading && archiveUes.length > 0 && (
        <section className="mt-10 border-t border-border pt-6">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                [ 02 / ARCHIVES &amp; AUTRES PROMOTIONS · HORS CLASSE{" "}
                {userClassLevel} ]
              </p>
              <h2 className="mt-0.5 flex items-center gap-2 text-sm font-bold uppercase tracking-tight text-ink">
                <Archive className="h-4 w-4 text-stone" />
                <span>REGISTRES VALIDÉS &amp; DOSSIERS DE SYNTHÈSE</span>
              </h2>
            </div>

            {archiveUes.length > 4 && (
              <button
                type="button"
                onClick={() => setShowAllArchives((p) => !p)}
                className="font-mono text-[11px] uppercase tracking-wider text-ink underline hover:text-stone"
              >
                {showAllArchives
                  ? "RÉDUIRE LES ARCHIVES"
                  : `CONSULTER TOUTES LES ARCHIVES (${archiveUes.length}) →`}
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {visibleArchives.map((ue) => (
              <article
                key={ue.id}
                className="flex flex-col justify-between border border-border bg-card p-4"
              >
                <div>
                  <div className="mb-2 flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-wider text-stone">
                    <span>
                      {ue.code} · {ue.classLevel || "VET2"}
                    </span>
                    <span className="text-badge-text">{ue.semester}</span>
                  </div>
                  <h3 className="text-sm font-bold uppercase leading-snug text-ink">
                    {ue.title}
                  </h3>
                  <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-stone">
                    {ue.description || "Dossier de cours et notes archivées."}
                  </p>
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-border pt-2.5 font-mono text-[10px] uppercase tracking-wider">
                  <span className="text-stone">
                    {ue.officialCount} PDF · {ue.noteCount} NOTES
                  </span>
                  <Link
                    href={`/ue/${ue.id}`}
                    className="inline-flex items-center gap-1 font-semibold text-ink hover:underline"
                  >
                    <span>OUVRIR ARCHIVE</span>
                    <ArrowUpRight className="h-3 w-3" />
                  </Link>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </AppShell>
  );
}
