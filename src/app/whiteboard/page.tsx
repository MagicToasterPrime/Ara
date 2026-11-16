"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  ArrowUpRight,
  Check,
  Globe,
  Lock,
  PenTool,
  Plus,
  Trash2,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";

interface WhiteboardItem {
  id: string;
  ueId: string | null;
  title: string;
  creatorId: string;
  isPublic: boolean;
  isIntegrated: boolean;
  updatedAt: string;
  ue: {
    id: string;
    code: string;
    title: string;
    accentColor: string;
  } | null;
  creator: {
    id: string;
    name: string;
  };
}

interface UEOption {
  id: string;
  code: string;
  title: string;
  roles: Array<{ user: { id: string } }>;
}

function WhiteboardDirectoryContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { data: session } = useSession();

  const initialUeFilter = searchParams.get("ueId") || "";

  const [whiteboards, setWhiteboards] = useState<WhiteboardItem[]>([]);
  const [ues, setUes] = useState<UEOption[]>([]);
  const [ueFilter, setUeFilter] = useState(initialUeFilter);
  const [loading, setLoading] = useState(true);

  const [newTitle, setNewTitle] = useState("");
  const [newUeId, setNewUeId] = useState(initialUeFilter);
  const [newIsPublic, setNewIsPublic] = useState(false);
  const [creating, setCreating] = useState(false);

  const fetchData = useCallback(async () => {
    try {
      const [wbRes, ueRes] = await Promise.all([
        fetch(
          ueFilter
            ? `/api/whiteboards?ueId=${encodeURIComponent(ueFilter)}`
            : "/api/whiteboards",
          { cache: "no-store" }
        ),
        fetch("/api/ues", { cache: "no-store" }),
      ]);

      if (wbRes.ok) {
        const data = (await wbRes.json()) as {
          whiteboards?: WhiteboardItem[];
        };
        setWhiteboards(data.whiteboards || []);
      }

      if (ueRes.ok) {
        const data = (await ueRes.json()) as { ues?: UEOption[] };
        setUes(data.ues || []);
      }
    } finally {
      setLoading(false);
    }
  }, [ueFilter]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const managedUeIds = useMemo(() => {
    const ids = new Set<string>();
    const uid = session?.user?.id;
    const isAdmin = session?.user?.globalRole === "YEAR_ADMIN";
    for (const ue of ues) {
      if (isAdmin || (uid && ue.roles?.some((r) => r.user.id === uid))) {
        ids.add(ue.id);
      }
    }
    return ids;
  }, [ues, session]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!newTitle.trim() || creating) return;
    setCreating(true);
    try {
      const res = await fetch("/api/whiteboards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: newTitle.trim(),
          ueId: newUeId || null,
          isPublic: newIsPublic,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { whiteboard: WhiteboardItem };
        router.push(`/whiteboard/${data.whiteboard.id}`);
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleUpdateBoard(
    id: string,
    patch: { isPublic?: boolean; isIntegrated?: boolean }
  ) {
    const res = await fetch(`/api/whiteboards/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (res.ok) {
      await fetchData();
    }
  }

  async function handleDelete(id: string) {
    if (!confirm("Supprimer ce tableau blanc collaboratif ?")) return;
    const res = await fetch(`/api/whiteboards/${id}`, { method: "DELETE" });
    if (res.ok) {
      await fetchData();
    }
  }

  const myBoards = whiteboards.filter(
    (wb) => wb.creatorId === session?.user?.id
  );
  const communityBoards = whiteboards.filter(
    (wb) =>
      wb.creatorId !== session?.user?.id && (wb.isPublic || wb.isIntegrated)
  );

  return (
    <div className="space-y-8">
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-ink">
            MES TABLEAUX BLANCS (TLDRAW)
          </h1>
          <p className="font-mono text-[11px] uppercase tracking-wider text-stone">
            [ ESPACE PERSONNEL PRIVÉ/PUBLIC · INTÉGRATION PAR LES RESPONSABLES D&apos;UE ]
          </p>
        </div>

        <select
          value={ueFilter}
          onChange={(e) => setUeFilter(e.target.value)}
          className="border border-border bg-card px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink focus:border-ink focus:outline-none"
        >
          <option value="">TOUTES LES UE</option>
          {ues.map((ue) => (
            <option key={ue.id} value={ue.id}>
              {ue.code} — {ue.title}
            </option>
          ))}
        </select>
      </div>

      {/* Create Whiteboard Form */}
      <form
        onSubmit={handleCreate}
        className="flex flex-wrap items-end gap-3 border border-border bg-card p-4"
        style={{ borderTop: "3px solid #3D6B99" }}
      >
        <div className="min-w-[200px] flex-1">
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
            TITRE DU TABLEAU
          </label>
          <input
            type="text"
            required
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            placeholder="Ex : Schéma physiologie rénale"
            className="w-full border border-border bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
          />
        </div>

        <div className="w-56">
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
            UE ASSOCIÉE (OPTIONNEL)
          </label>
          <select
            value={newUeId}
            onChange={(e) => setNewUeId(e.target.value)}
            className="w-full border border-border bg-paper px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink focus:border-ink focus:outline-none"
          >
            <option value="">ESPACE PERSONNEL LIBRE</option>
            {ues.map((ue) => (
              <option key={ue.id} value={ue.id}>
                {ue.code} — {ue.title}
              </option>
            ))}
          </select>
        </div>

        <div className="w-60">
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
            VISIBILITÉ
          </label>
          <select
            value={newIsPublic ? "PUBLIC" : "PRIVATE"}
            onChange={(e) => setNewIsPublic(e.target.value === "PUBLIC")}
            className="w-full border border-border bg-paper px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink focus:border-ink focus:outline-none"
          >
            <option value="PRIVATE">PRIVÉ (MOI UNIQUEMENT)</option>
            <option value="PUBLIC">PUBLIC (PROPOSÉ À L&apos;UE)</option>
          </select>
        </div>

        <button
          type="submit"
          disabled={creating || !newTitle.trim()}
          className="inline-flex items-center gap-1.5 border border-ink bg-ink px-4 py-2 font-mono text-xs uppercase tracking-wider text-card hover:bg-ink/90 disabled:opacity-50"
        >
          <Plus className="h-3.5 w-3.5" />
          <span>{creating ? "CRÉATION..." : "CRÉER & OUVRIR"}</span>
        </button>
      </form>

      {loading ? (
        <div className="border border-border bg-card p-8 font-mono text-xs uppercase tracking-wider text-stone">
          CHARGEMENT DES TABLEAUX...
        </div>
      ) : (
        <>
          {/* Section 1: My Personal Whiteboards */}
          <section className="space-y-4">
            <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
              01 / MES TABLEAUX BLANCS PERSONNELS ({myBoards.length})
            </h2>

            {myBoards.length === 0 ? (
              <div className="border border-border bg-card p-8 text-center">
                <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center border border-border bg-paper">
                  <PenTool className="h-4 w-4 text-stone" />
                </div>
                <p className="font-mono text-xs uppercase tracking-wider text-ink">
                  VOUS N&apos;AVEZ PAS ENCORE DE TABLEAU BLANC PERSONNEL
                </p>
                <p className="mt-1 text-sm text-stone">
                  Créez un tableau privé pour vos révisions ou public pour le
                  proposer à votre UE.
                </p>
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {myBoards.map((wb) => {
                  const canIntegrate = Boolean(
                    wb.ueId && managedUeIds.has(wb.ueId)
                  );
                  return (
                    <article
                      key={wb.id}
                      className="flex flex-col justify-between border border-border bg-card p-5"
                      style={{
                        borderTop: `3px solid ${
                          wb.ue?.accentColor || "#3D6B99"
                        }`,
                      }}
                    >
                      <div>
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-wider text-stone">
                          <span>{wb.ue ? wb.ue.code : "SANS UE"}</span>
                          <span>
                            MÀJ{" "}
                            {new Date(wb.updatedAt).toLocaleDateString(
                              "fr-FR",
                              { day: "2-digit", month: "short" }
                            )}
                          </span>
                        </div>

                        <h3 className="text-base font-bold uppercase tracking-tight text-ink">
                          {wb.title}
                        </h3>

                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <span
                            className={`inline-flex items-center gap-1 border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                              wb.isPublic
                                ? "border-forest/40 bg-forest/10 text-forest"
                                : "border-border bg-paper text-stone"
                            }`}
                          >
                            {wb.isPublic ? (
                              <>
                                <Globe className="h-3 w-3" />
                                PUBLIC
                              </>
                            ) : (
                              <>
                                <Lock className="h-3 w-3" />
                                PRIVÉ
                              </>
                            )}
                          </span>

                          {wb.isIntegrated && wb.ue && (
                            <span className="bg-badge-bg px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-badge-text">
                              INTÉGRÉ · {wb.ue.code}
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="mt-5 space-y-2 border-t border-border pt-3">
                        <div className="flex flex-wrap gap-1.5">
                          <button
                            type="button"
                            onClick={() =>
                              handleUpdateBoard(wb.id, {
                                isPublic: !wb.isPublic,
                              })
                            }
                            className="flex-1 border border-border bg-paper px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink"
                          >
                            {wb.isPublic
                              ? "PASSER EN PRIVÉ"
                              : "RENDRE PUBLIC"}
                          </button>

                          {canIntegrate && (
                            <button
                              type="button"
                              onClick={() =>
                                handleUpdateBoard(wb.id, {
                                  isIntegrated: !wb.isIntegrated,
                                })
                              }
                              className="border border-badge-text bg-badge-bg px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-badge-text hover:bg-badge-text hover:text-card"
                            >
                              {wb.isIntegrated ? "RETIRER UE" : "INTÉGRER UE"}
                            </button>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          <Link
                            href={`/whiteboard/${wb.id}`}
                            className="inline-flex flex-1 items-center justify-center gap-1.5 border border-ink bg-ink px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-card hover:bg-ink/90"
                          >
                            <span>OUVRIR LE TABLEAU</span>
                            <ArrowUpRight className="h-3.5 w-3.5" />
                          </Link>
                          <button
                            type="button"
                            onClick={() => handleDelete(wb.id)}
                            className="border border-border bg-paper p-2 text-stone hover:border-carmine hover:text-carmine"
                            title="Supprimer ce tableau"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          {/* Section 2: Public & Integrated Community Boards */}
          <section className="space-y-4">
            <h2 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
              02 / TABLEAUX PUBLICS &amp; INTÉGRÉS DE LA PROMOTION (
              {communityBoards.length})
            </h2>

            {communityBoards.length === 0 ? (
              <div className="border border-border bg-card p-6 text-center font-mono text-xs uppercase tracking-wider text-stone">
                AUCUN TABLEAU PUBLIC PARTAGÉ PAR D&apos;AUTRES ÉTUDIANTS POUR LE
                MOMENT.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
                {communityBoards.map((wb) => {
                  const canIntegrate = Boolean(
                    wb.ueId && managedUeIds.has(wb.ueId)
                  );
                  return (
                    <article
                      key={wb.id}
                      className="flex flex-col justify-between border border-border bg-card p-5"
                      style={{
                        borderTop: `3px solid ${
                          wb.ue?.accentColor || "#3D6B99"
                        }`,
                      }}
                    >
                      <div>
                        <div className="mb-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-stone">
                          <span>{wb.ue ? wb.ue.code : "PROMO"}</span>
                          <span>
                            MÀJ{" "}
                            {new Date(wb.updatedAt).toLocaleDateString(
                              "fr-FR",
                              { day: "2-digit", month: "short" }
                            )}
                          </span>
                        </div>

                        <h3 className="text-base font-bold uppercase tracking-tight text-ink">
                          {wb.title}
                        </h3>

                        <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-stone">
                          PAR : {wb.creator.name}
                        </p>

                        <div className="mt-2 flex flex-wrap gap-1.5">
                          <span className="inline-flex items-center gap-1 border border-forest/40 bg-forest/10 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-forest">
                            <Globe className="h-3 w-3" />
                            PUBLIC
                          </span>
                          {wb.isIntegrated && wb.ue && (
                            <span className="bg-badge-bg px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-badge-text">
                              INTÉGRÉ PAR RESP. UE
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                        <Link
                          href={`/whiteboard/${wb.id}`}
                          className="inline-flex flex-1 items-center justify-center gap-1.5 border border-border bg-paper px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-ink hover:border-ink hover:bg-pinned"
                        >
                          <span>OUVRIR</span>
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        </Link>
                        {canIntegrate && (
                          <button
                            type="button"
                            onClick={() =>
                              handleUpdateBoard(wb.id, {
                                isIntegrated: !wb.isIntegrated,
                              })
                            }
                            className="inline-flex items-center gap-1 border border-badge-text bg-badge-bg px-3 py-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-badge-text hover:bg-badge-text hover:text-card"
                          >
                            <Check className="h-3 w-3" />
                            <span>
                              {wb.isIntegrated ? "RETIRER UE" : "INTÉGRER UE"}
                            </span>
                          </button>
                        )}
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

export default function WhiteboardsPage() {
  return (
    <AppShell>
      <Suspense
        fallback={
          <div className="border border-border bg-card p-8 font-mono text-xs uppercase tracking-wider text-stone">
            CHARGEMENT...
          </div>
        }
      >
        <WhiteboardDirectoryContent />
      </Suspense>
    </AppShell>
  );
}
