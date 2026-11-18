"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { ArrowLeft, Check, Globe, Lock } from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { useSpix } from "@/components/SpixContext";

const WhiteboardCanvas = dynamic(
  () =>
    import("@/components/WhiteboardCanvas").then((mod) => mod.WhiteboardCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center border border-border bg-card font-mono text-xs uppercase tracking-wider text-stone">
        CHARGEMENT DE L&apos;ATELIER TABLEAU BLANC...
      </div>
    ),
  }
);

interface WhiteboardData {
  id: string;
  title: string;
  creatorId: string;
  isPublic: boolean;
  isIntegrated: boolean;
  snapshotData: string;
  creator: {
    id: string;
    name: string;
  };
  ue: {
    id: string;
    code: string;
    title: string;
    accentColor: string;
  } | null;
}

export default function WhiteboardDetailPage() {
  const params = useParams<{ id: string }>();
  const { data: session } = useSession();
  const { setPageContext } = useSpix();

  const [whiteboard, setWhiteboard] = useState<WhiteboardData | null>(null);
  const [canEditMeta, setCanEditMeta] = useState(false);
  const [canIntegrate, setCanIntegrate] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatingMeta, setUpdatingMeta] = useState(false);

  useEffect(() => {
    if (whiteboard?.ue) {
      setPageContext({
        mode: "UE",
        ueId: whiteboard.ue.id,
        ueCode: whiteboard.ue.code,
        ueTitle: whiteboard.ue.title,
        ueAccentColor: whiteboard.ue.accentColor,
      });
    } else {
      setPageContext({ mode: "GLOBAL" });
    }
    return () => {
      setPageContext({ mode: "GLOBAL" });
    };
  }, [whiteboard, setPageContext]);

  const loadBoard = useCallback(async () => {
    try {
      const res = await fetch(`/api/whiteboards/${params.id}`, {
        cache: "no-store",
      });
      const data = (await res.json().catch(() => ({}))) as {
        whiteboard?: WhiteboardData;
        canEditMeta?: boolean;
        canIntegrate?: boolean;
        error?: string;
      };
      if (!res.ok || !data.whiteboard) {
        throw new Error(data.error || "Tableau introuvable");
      }
      setWhiteboard(data.whiteboard);
      setCanEditMeta(Boolean(data.canEditMeta));
      setCanIntegrate(Boolean(data.canIntegrate));
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Erreur de chargement."
      );
    } finally {
      setLoading(false);
    }
  }, [params.id]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  async function handlePatch(patch: {
    isPublic?: boolean;
    isIntegrated?: boolean;
  }) {
    if (!whiteboard || updatingMeta) return;
    setUpdatingMeta(true);
    try {
      const res = await fetch(`/api/whiteboards/${whiteboard.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const data = (await res.json()) as { whiteboard: WhiteboardData };
        setWhiteboard((prev) =>
          prev
            ? {
                ...prev,
                isPublic: data.whiteboard.isPublic,
                isIntegrated: data.whiteboard.isIntegrated,
              }
            : prev
        );
      }
    } finally {
      setUpdatingMeta(false);
    }
  }

  return (
    <AppShell>
      {loading ? (
        <div className="border border-border bg-card p-8 font-mono text-xs uppercase tracking-wider text-stone">
          CHARGEMENT DU TABLEAU BLANC...
        </div>
      ) : error || !whiteboard ? (
        <div className="border border-border bg-card p-8">
          <p className="font-mono text-xs uppercase tracking-wider text-carmine">
            {error || "Tableau introuvable"}
          </p>
          <Link
            href="/whiteboard"
            className="mt-4 inline-flex items-center gap-2 border border-border bg-paper px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            <span>RETOUR AUX TABLEAUX</span>
          </Link>
        </div>
      ) : (
        <div className="flex h-[calc(100vh-220px)] min-h-[600px] flex-col space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-card px-4 py-2.5">
            <div className="flex items-center gap-3">
              <Link
                href={
                  whiteboard.ue
                    ? `/ue/${whiteboard.ue.id}?tab=whiteboards`
                    : "/whiteboard"
                }
                className="inline-flex h-8 w-8 items-center justify-center border border-border bg-paper text-ink hover:bg-pinned"
              >
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-sm font-bold uppercase tracking-tight text-ink">
                    {whiteboard.title}
                  </h1>
                  {whiteboard.ue && (
                    <Link
                      href={`/ue/${whiteboard.ue.id}?tab=whiteboards`}
                      className="bg-badge-bg px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-badge-text"
                    >
                      {whiteboard.ue.code}
                    </Link>
                  )}
                  <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
                    PAR {whiteboard.creator.name}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              {canEditMeta ? (
                <button
                  type="button"
                  disabled={updatingMeta}
                  onClick={() =>
                    handlePatch({ isPublic: !whiteboard.isPublic })
                  }
                  className={`inline-flex items-center gap-1.5 border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors ${
                    whiteboard.isPublic
                      ? "border-forest/40 bg-forest/10 text-forest hover:bg-forest/20"
                      : "border-border bg-paper text-ink hover:border-ink"
                  }`}
                >
                  {whiteboard.isPublic ? (
                    <>
                      <Globe className="h-3.5 w-3.5" />
                      <span>PUBLIC (CLIC POUR PRIVÉ)</span>
                    </>
                  ) : (
                    <>
                      <Lock className="h-3.5 w-3.5" />
                      <span>PRIVÉ (CLIC POUR PUBLIC)</span>
                    </>
                  )}
                </button>
              ) : (
                <span className="inline-flex items-center gap-1 border border-forest/40 bg-forest/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-forest">
                  <Globe className="h-3 w-3" />
                  PUBLIC
                </span>
              )}

              {whiteboard.ue && canIntegrate && (
                <button
                  type="button"
                  disabled={updatingMeta}
                  onClick={() =>
                    handlePatch({ isIntegrated: !whiteboard.isIntegrated })
                  }
                  className={`inline-flex items-center gap-1.5 border px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors ${
                    whiteboard.isIntegrated
                      ? "border-badge-text bg-badge-bg font-semibold text-badge-text hover:bg-badge-text hover:text-card"
                      : "border-ink bg-ink text-card hover:bg-ink/90"
                  }`}
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>
                    {whiteboard.isIntegrated
                      ? `INTÉGRÉ À ${whiteboard.ue.code} (RETIRER)`
                      : `INTÉGRER À ${whiteboard.ue.code}`}
                  </span>
                </button>
              )}

              {whiteboard.ue && !canIntegrate && whiteboard.isIntegrated && (
                <span className="bg-badge-bg px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-badge-text">
                  INTÉGRÉ PAR RESP. UE
                </span>
              )}
            </div>
          </div>

          <div className="min-h-0 flex-1">
            {session?.user && (
              <WhiteboardCanvas
                whiteboardId={whiteboard.id}
                initialSnapshot={whiteboard.snapshotData}
                userId={session.user.id}
                userName={session.user.name}
              />
            )}
          </div>
        </div>
      )}
    </AppShell>
  );
}
