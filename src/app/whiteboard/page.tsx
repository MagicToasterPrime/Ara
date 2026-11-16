"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { ArrowUpRight, PenTool, Plus, Trash2 } from "lucide-react";
import { AppShell } from "@/components/AppShell";

interface WhiteboardItem {
  id: string;
  ueId: string | null;
  title: string;
  creatorId: string;
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

  async function handleDelete(id: string) {
    if (!confirm("Supprimer ce tableau blanc collaboratif ?")) return;
    const res = await fetch(`/api/whiteboards/${id}`, { method: "DELETE" });
    if (res.ok) {
      await fetchData();
    }
  }

  return (
    <div className="space-y-6">
      {/* Top Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-ink">
            TABLEAUX BLANCS COLLABORATIFS (TLDRAW)
          </h1>
          <p className="font-mono text-[11px] uppercase tracking-wider text-stone">
            [ CURSEURS TEMPS RÉEL · SAUVEGARDE AUTO EN POSTGRESQL TOUTES LES 3S ]
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
        <div className="min-w-[220px] flex-1">
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
            TITRE DU NOUVEAU TABLEAU
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

        <div className="w-64">
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
            UE ASSOCIÉE (OPTIONNEL)
          </label>
          <select
            value={newUeId}
            onChange={(e) => setNewUeId(e.target.value)}
            className="w-full border border-border bg-paper px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink focus:border-ink focus:outline-none"
          >
            <option value="">ESPACE LIBRE PROMO</option>
            {ues.map((ue) => (
              <option key={ue.id} value={ue.id}>
                {ue.code} — {ue.title}
              </option>
            ))}
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

      {/* Directory Grid */}
      {loading ? (
        <div className="border border-border bg-card p-8 font-mono text-xs uppercase tracking-wider text-stone">
          CHARGEMENT DES TABLEAUX...
        </div>
      ) : whiteboards.length === 0 ? (
        <div className="border border-border bg-card p-10 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center border border-border bg-paper">
            <PenTool className="h-5 w-5 text-stone" />
          </div>
          <h2 className="text-base font-bold uppercase tracking-tight text-ink">
            AUCUN TABLEAU BLANC DISPONIBLE
          </h2>
          <p className="mt-1 text-sm text-stone">
            Créez un tableau collaboratif ci-dessus pour schématiser en direct
            avec la promotion.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {whiteboards.map((wb) => {
            const canDelete =
              session?.user?.globalRole === "YEAR_ADMIN" ||
              session?.user?.id === wb.creatorId;
            return (
              <article
                key={wb.id}
                className="flex flex-col justify-between border border-border bg-card p-5"
                style={{
                  borderTop: `3px solid ${wb.ue?.accentColor || "#3D6B99"}`,
                }}
              >
                <div>
                  <div className="mb-3 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-stone">
                    <span>{wb.ue ? wb.ue.code : "PROMO GÉNÉRAL"}</span>
                    <span>
                      MÀJ{" "}
                      {new Date(wb.updatedAt).toLocaleDateString("fr-FR", {
                        day: "2-digit",
                        month: "short",
                      })}
                    </span>
                  </div>

                  <h3 className="text-base font-bold uppercase tracking-tight text-ink">
                    {wb.title}
                  </h3>

                  <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-stone">
                    CRÉÉ PAR : {wb.creator.name}
                  </p>
                </div>

                <div className="mt-5 flex items-center gap-2 border-t border-border pt-3">
                  <Link
                    href={`/whiteboard/${wb.id}`}
                    className="inline-flex flex-1 items-center justify-center gap-1.5 border border-border bg-paper px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-ink hover:border-ink hover:bg-pinned"
                  >
                    <span>OUVRIR LE TABLEAU</span>
                    <ArrowUpRight className="h-3.5 w-3.5" />
                  </Link>
                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => handleDelete(wb.id)}
                      className="border border-border bg-paper p-2 text-stone hover:border-carmine hover:text-carmine"
                      title="Supprimer ce tableau"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
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
