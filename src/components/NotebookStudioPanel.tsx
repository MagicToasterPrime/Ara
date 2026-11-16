"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  BookOpen,
  FileCode2,
  FileText,
  Globe,
  Layers,
  ListChecks,
  Loader2,
  Lock,
  Sparkles,
  Trash2,
} from "lucide-react";
import { StudioArtifactViewer } from "@/components/StudioArtifactViewer";
import { renderPdfPageToDataUrl } from "@/lib/pdf-client";
import type {
  PageImageInput,
  StudioArtifactContent,
  StudioArtifactKind,
  StudioSourceRef,
} from "@/lib/studio";

interface StudioDocOption {
  id: string;
  title: string;
  fileName: string;
  pageCount: number;
  category: string;
}

interface StudioArtifactRow {
  id: string;
  userId: string;
  ueId: string | null;
  documentId: string | null;
  kind: StudioArtifactKind;
  title: string;
  prompt: string | null;
  contentJson: string;
  isPublic: boolean;
  createdAt: string;
  user: { id: string; name: string };
}

interface NotebookStudioPanelProps {
  ueId: string;
  ueCode: string;
  documents: StudioDocOption[];
  onOpenSource?: (source: StudioSourceRef) => void;
}

const KIND_LABELS: Record<StudioArtifactKind, string> = {
  SVG_DIAGRAM: "SCHÉMA .SVG",
  FLASHCARDS: "FLASHCARDS",
  QUIZ: "QUIZ CIBLÉ",
  SUMMARY: "FICHE SYNTHÈSE",
};

export function NotebookStudioPanel({
  ueId,
  ueCode,
  documents,
  onOpenSource,
}: NotebookStudioPanelProps) {
  const { data: session } = useSession();
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>(() =>
    documents.map((d) => d.id)
  );
  const [prompt, setPrompt] = useState("");
  const [generatingKind, setGeneratingKind] =
    useState<StudioArtifactKind | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [artifacts, setArtifacts] = useState<StudioArtifactRow[]>([]);
  const [activeArtifact, setActiveArtifact] =
    useState<StudioArtifactRow | null>(null);
  const [loadingList, setLoadingList] = useState(true);

  useEffect(() => {
    setSelectedDocIds((prev) =>
      prev.length > 0 ? prev : documents.map((d) => d.id)
    );
  }, [documents]);

  const fetchArtifacts = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/studio?ueId=${encodeURIComponent(ueId)}`,
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const data = (await res.json()) as { artifacts?: StudioArtifactRow[] };
      const list = data.artifacts || [];
      setArtifacts(list);
      setActiveArtifact((prev) => prev || list[0] || null);
    } finally {
      setLoadingList(false);
    }
  }, [ueId]);

  useEffect(() => {
    void fetchArtifacts();
  }, [fetchArtifacts]);

  function toggleDoc(docId: string) {
    setSelectedDocIds((prev) =>
      prev.includes(docId)
        ? prev.filter((id) => id !== docId)
        : [...prev, docId]
    );
  }

  async function handleGenerate(kind: StudioArtifactKind) {
    if (generatingKind) return;
    setGeneratingKind(kind);
    setError(null);

    try {
      const pageImagesBase64: PageImageInput[] = [];
      if (selectedDocIds.length > 0) {
        const firstDoc = documents.find((d) => d.id === selectedDocIds[0]);
        if (firstDoc) {
          const dataUrl = await renderPdfPageToDataUrl(firstDoc.id, 1, 900);
          if (dataUrl) {
            pageImagesBase64.push({
              pageNumber: 1,
              documentTitle: firstDoc.title,
              base64: dataUrl,
            });
          }
        }
      }

      const res = await fetch("/api/studio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind,
          ueId,
          documentIds: selectedDocIds,
          prompt: prompt.trim() || undefined,
          pageImagesBase64,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        artifact?: StudioArtifactRow;
        error?: string;
      };
      if (!res.ok || !data.artifact) {
        setError(data.error || "Erreur lors de la génération.");
        return;
      }
      setActiveArtifact(data.artifact);
      await fetchArtifacts();
    } finally {
      setGeneratingKind(null);
    }
  }

  async function handleTogglePublic(artifact: StudioArtifactRow) {
    const res = await fetch(`/api/studio/${artifact.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPublic: !artifact.isPublic }),
    });
    if (res.ok) {
      await fetchArtifacts();
    }
  }

  async function handleDelete(id: string) {
    const res = await fetch(`/api/studio/${id}`, { method: "DELETE" });
    if (res.ok) {
      if (activeArtifact?.id === id) setActiveArtifact(null);
      await fetchArtifacts();
    }
  }

  let parsedContent: StudioArtifactContent | null = null;
  if (activeArtifact) {
    try {
      parsedContent = JSON.parse(
        activeArtifact.contentJson
      ) as StudioArtifactContent;
    } catch {
      parsedContent = null;
    }
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      {/* Left 4 Columns: Sources Selector & History */}
      <aside className="space-y-4 lg:col-span-4">
        {/* Source Documents Checkboxes */}
        <div className="border border-border bg-card">
          <div className="flex items-center justify-between border-b border-border bg-paper px-4 py-2.5">
            <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
              SOURCES DU STUDIO ({selectedDocIds.length}/{documents.length})
            </span>
            <button
              type="button"
              onClick={() =>
                setSelectedDocIds(
                  selectedDocIds.length === documents.length
                    ? []
                    : documents.map((d) => d.id)
                )
              }
              className="font-mono text-[10px] uppercase tracking-wider text-badge-text hover:underline"
            >
              {selectedDocIds.length === documents.length
                ? "TOUT DÉSÉLECTIONNER"
                : "TOUT SÉLECTIONNER"}
            </button>
          </div>

          {documents.length === 0 ? (
            <div className="p-4 font-mono text-xs text-stone">
              Déposez des PDF dans cette UE pour activer le Studio Notebook.
            </div>
          ) : (
            <div className="max-h-60 divide-y divide-border overflow-y-auto">
              {documents.map((doc) => {
                const checked = selectedDocIds.includes(doc.id);
                return (
                  <label
                    key={doc.id}
                    className={`flex cursor-pointer items-start gap-2.5 px-3.5 py-2.5 text-xs ${
                      checked ? "bg-pinned" : "bg-card hover:bg-paper"
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggleDoc(doc.id)}
                      className="mt-0.5 accent-ink"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-semibold text-ink">
                        {doc.title}
                      </p>
                      <p className="font-mono text-[10px] uppercase text-stone">
                        {doc.fileName} · {doc.pageCount} P.
                      </p>
                    </div>
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Saved Artifacts History */}
        <div className="border border-border bg-card">
          <div className="border-b border-border bg-paper px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider text-ink">
            PRODUCTIONS ENREGISTRÉES ({artifacts.length})
          </div>

          {loadingList ? (
            <div className="p-4 font-mono text-xs text-stone">
              CHARGEMENT...
            </div>
          ) : artifacts.length === 0 ? (
            <div className="p-4 font-mono text-xs text-stone">
              Aucune production pour {ueCode}. Générez un schéma .SVG, des
              flashcards ou un quiz à droite.
            </div>
          ) : (
            <div className="max-h-80 divide-y divide-border overflow-y-auto">
              {artifacts.map((art) => {
                const isActive = activeArtifact?.id === art.id;
                const isMine =
                  art.userId === session?.user?.id ||
                  session?.user?.globalRole === "YEAR_ADMIN";
                return (
                  <div
                    key={art.id}
                    className={`p-3 ${isActive ? "bg-pinned" : "bg-card"}`}
                  >
                    <button
                      type="button"
                      onClick={() => setActiveArtifact(art)}
                      className="block w-full text-left"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="bg-badge-bg px-1.5 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-wider text-badge-text">
                          {KIND_LABELS[art.kind] || art.kind}
                        </span>
                        <span className="font-mono text-[9px] uppercase text-stone">
                          {art.isPublic ? "PUBLIC" : "PRIVÉ"}
                        </span>
                      </div>
                      <p className="mt-1 truncate text-xs font-bold text-ink">
                        {art.title}
                      </p>
                      <p className="font-mono text-[10px] text-stone">
                        PAR {art.user.name}
                      </p>
                    </button>

                    {isMine && (
                      <div className="mt-2 flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleTogglePublic(art)}
                          className="inline-flex items-center gap-1 border border-border bg-paper px-2 py-0.5 font-mono text-[9px] uppercase text-ink hover:border-ink"
                        >
                          {art.isPublic ? (
                            <>
                              <Lock className="h-2.5 w-2.5" />
                              <span>PASSER PRIVÉ</span>
                            </>
                          ) : (
                            <>
                              <Globe className="h-2.5 w-2.5" />
                              <span>PARTAGER À {ueCode}</span>
                            </>
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(art.id)}
                          className="border border-border bg-paper p-1 text-stone hover:border-carmine hover:text-carmine"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </aside>

      {/* Right 8 Columns: Generator Bar + Active Viewer */}
      <section className="space-y-4 lg:col-span-8">
        <div
          className="border border-border bg-card p-4"
          style={{ borderTop: "3px solid #3B7A57" }}
        >
          <div className="mb-3 flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-ink" />
            <span className="font-mono text-xs font-bold uppercase tracking-wider text-ink">
              STUDIO NOTEBOOK · GÉNÉRER À PARTIR DES SOURCES SÉLECTIONNÉES
            </span>
          </div>

          {error && (
            <div className="mb-3 border border-carmine/40 bg-carmine/10 px-3 py-2 font-mono text-xs text-carmine">
              {error}
            </div>
          )}

          <input
            type="text"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Thème ciblé (optionnel) — ex : Cycle de Krebs, mécanismes d'action, anatomie du membre..."
            className="mb-3 w-full border border-border bg-paper px-3 py-2 text-sm text-ink placeholder:text-stone focus:border-ink focus:outline-none"
          />

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <button
              type="button"
              disabled={Boolean(generatingKind) || documents.length === 0}
              onClick={() => handleGenerate("SVG_DIAGRAM")}
              className="flex items-center justify-center gap-1.5 border border-ink bg-ink px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-card hover:bg-ink/90 disabled:opacity-50"
            >
              {generatingKind === "SVG_DIAGRAM" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <FileCode2 className="h-3.5 w-3.5" />
              )}
              <span>SCHÉMA .SVG</span>
            </button>

            <button
              type="button"
              disabled={Boolean(generatingKind) || documents.length === 0}
              onClick={() => handleGenerate("FLASHCARDS")}
              className="flex items-center justify-center gap-1.5 border border-border bg-paper px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink hover:bg-pinned disabled:opacity-50"
            >
              {generatingKind === "FLASHCARDS" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Layers className="h-3.5 w-3.5" />
              )}
              <span>FLASHCARDS</span>
            </button>

            <button
              type="button"
              disabled={Boolean(generatingKind) || documents.length === 0}
              onClick={() => handleGenerate("QUIZ")}
              className="flex items-center justify-center gap-1.5 border border-border bg-paper px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink hover:bg-pinned disabled:opacity-50"
            >
              {generatingKind === "QUIZ" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <ListChecks className="h-3.5 w-3.5" />
              )}
              <span>QUIZ CIBLÉ</span>
            </button>

            <button
              type="button"
              disabled={Boolean(generatingKind) || documents.length === 0}
              onClick={() => handleGenerate("SUMMARY")}
              className="flex items-center justify-center gap-1.5 border border-border bg-paper px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink hover:bg-pinned disabled:opacity-50"
            >
              {generatingKind === "SUMMARY" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <BookOpen className="h-3.5 w-3.5" />
              )}
              <span>SYNTHÈSE</span>
            </button>
          </div>
        </div>

        {/* Active Viewer */}
        {activeArtifact && parsedContent ? (
          <StudioArtifactViewer
            key={activeArtifact.id}
            title={activeArtifact.title}
            content={parsedContent}
            onOpenSource={onOpenSource}
          />
        ) : (
          <div className="border border-border bg-card p-10 text-center">
            <FileText className="mx-auto mb-3 h-6 w-6 text-stone" />
            <p className="font-mono text-xs font-bold uppercase tracking-wider text-ink">
              ATELIER NOTEBOOK PRÊT POUR {ueCode}
            </p>
            <p className="mx-auto mt-1.5 max-w-md text-sm text-stone">
              Sélectionnez vos polycopiés ou notes à gauche puis générez un
              schéma vectoriel téléchargeable en <code>.svg</code>, un jeu de
              flashcards, un quiz ciblé ou une fiche synthèse.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
