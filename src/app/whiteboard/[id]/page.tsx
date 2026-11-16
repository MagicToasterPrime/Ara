"use client";

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useSession } from "next-auth/react";
import { ArrowLeft } from "lucide-react";
import { AppShell } from "@/components/AppShell";

const WhiteboardCanvas = dynamic(
  () =>
    import("@/components/WhiteboardCanvas").then((mod) => mod.WhiteboardCanvas),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-full items-center justify-center border border-border bg-card font-mono text-xs uppercase tracking-wider text-stone">
        CHARGEMENT DE L&apos;ÉDITEUR TLDRAW...
      </div>
    ),
  }
);

interface WhiteboardData {
  id: string;
  title: string;
  snapshotData: string;
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
  const [whiteboard, setWhiteboard] = useState<WhiteboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/whiteboards/${params.id}`, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error("Tableau introuvable");
        return res.json();
      })
      .then((data: { whiteboard: WhiteboardData }) => {
        if (active) setWhiteboard(data.whiteboard);
      })
      .catch((err) => {
        if (active)
          setError(
            err instanceof Error ? err.message : "Erreur de chargement."
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [params.id]);

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
                href="/whiteboard"
                className="inline-flex h-8 w-8 items-center justify-center border border-border bg-paper text-ink hover:bg-pinned"
              >
                <ArrowLeft className="h-4 w-4" />
              </Link>
              <div>
                <div className="flex items-center gap-2">
                  <h1 className="text-sm font-bold uppercase tracking-tight text-ink">
                    {whiteboard.title}
                  </h1>
                  {whiteboard.ue && (
                    <Link
                      href={`/ue/${whiteboard.ue.id}`}
                      className="bg-badge-bg px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-badge-text"
                    >
                      {whiteboard.ue.code}
                    </Link>
                  )}
                </div>
              </div>
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
