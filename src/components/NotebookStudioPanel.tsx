"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  AlertTriangle,
  BookOpen,
  FileCode2,
  FileText,
  Globe,
  Layers,
  ListChecks,
  Loader2,
  Lock,
  RefreshCw,
  Sparkles,
  Trash2,
} from "lucide-react";
import { useSpix } from "@/components/SpixContext";
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
  focusDocumentId?: string | null;
  onOpenSource?: (source: StudioSourceRef) => void;
}

const KIND_LABELS: Record<StudioArtifactKind, string> = {
  SVG_DIAGRAM: "SCHÉMA .SVG",
  FLASHCARDS: "FLASHCARDS",
  QUIZ: "QUIZ COMPRÉHENSION",
  SUMMARY: "FICHE RÉVISION",
};

const CONTEXT_CHIPS = [
  "Vérifier ma compréhension des mécanismes et liens cause-effet",
  "Cas pratiques, mises en situation et raisonnement clinique",
  "Pièges de partiel et confusions fréquentes entre notions",
  "Comparer et différencier les concepts clés du cours",
  "Valeurs clés, seuils et définitions essentielles",
];

export function NotebookStudioPanel({
  ueId,
  ueCode,
  documents,
  focusDocumentId,
  onOpenSource,
}: NotebookStudioPanelProps) {
  const { data: session } = useSession();
  const { userAiAndSpixEnabled: globalAiEnabled, setUserAiAndSpixEnabled } =
    useSpix();
  const [selectedDocIds, setSelectedDocIds] = useState<string[]>(() =>
    documents.map((d) => d.id)
  );
  const [prompt, setPrompt] = useState("");
  const [wantPublic, setWantPublic] = useState(true);
  const [userAiEnabled, setUserAiEnabled] = useState(true);
  const [generatingKind, setGeneratingKind] =
    useState<StudioArtifactKind | null>(null);
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoPublishNotice, setAutoPublishNotice] = useState<string | null>(
    null
  );
  const [aiNotice, setAiNotice] = useState<string | null>(null);

  const [artifacts, setArtifacts] = useState<StudioArtifactRow[]>([]);
  const [publicCoverage, setPublicCoverage] = useState<
    Array<{ documentId: string; kind: string }>
  >([]);
  const [activeArtifact, setActiveArtifact] =
    useState<StudioArtifactRow | null>(null);
  const [loadingList, setLoadingList] = useState(true);

  useEffect(() => {
    if (focusDocumentId) {
      setSelectedDocIds([focusDocumentId]);
      return;
    }
    setSelectedDocIds((prev) =>
      prev.length > 0 ? prev : documents.map((d) => d.id)
    );
  }, [documents, focusDocumentId]);

  const fetchArtifacts = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/studio?ueId=${encodeURIComponent(ueId)}`,
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        artifacts?: StudioArtifactRow[];
        publicCoverage?: Array<{ documentId: string; kind: string }>;
        userAiAndSpixEnabled?: boolean;
      };
      const list = data.artifacts || [];
      setArtifacts(list);
      setPublicCoverage(data.publicCoverage || []);
      if (typeof data.userAiAndSpixEnabled === "boolean") {
        setUserAiEnabled(data.userAiAndSpixEnabled);
        setUserAiAndSpixEnabled(data.userAiAndSpixEnabled);
      }
      setActiveArtifact((prev) => {
        if (focusDocumentId) {
          const match = list.find((a) => a.documentId === focusDocumentId);
          if (match) return match;
        }
        return prev || list[0] || null;
      });
    } finally {
      setLoadingList(false);
    }
  }, [ueId, focusDocumentId]);

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

  function appendContextChip(chip: string) {
    setPrompt((prev) => {
      const current = prev.trim();
      if (current.toLowerCase().includes(chip.toLowerCase())) {
        return prev;
      }
      return current ? `${current}\n• ${chip}` : `• ${chip}`;
    });
  }

  function hasPublicKindForDoc(
    docId: string,
    kind: StudioArtifactKind
  ): boolean {
    return publicCoverage.some(
      (c) => c.documentId === docId && c.kind === kind
    );
  }

  function selectionMissingPublicKind(kind: StudioArtifactKind): boolean {
    return selectedDocIds.some((docId) => !hasPublicKindForDoc(docId, kind));
  }

  const canGenerateAi = userAiEnabled && globalAiEnabled;

  async function handleGenerate(kind: StudioArtifactKind) {
    if (generatingKind || !canGenerateAi) return;
    setGeneratingKind(kind);
    setError(null);
    setAutoPublishNotice(null);
    setAiNotice(null);

    try {
      const pageImagesBase64: PageImageInput[] = [];
      if (kind === "SVG_DIAGRAM" && selectedDocIds.length > 0) {
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
          isPublic: wantPublic,
          pageImagesBase64,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        artifact?: StudioArtifactRow;
        autoPublishedFirst?: boolean;
        usedAi?: boolean;
        error?: string;
        code?: string;
      };
      if (!res.ok || !data.artifact) {
        if (res.status === 403 || data.code === "USER_AI_DISABLED") {
          setUserAiEnabled(false);
          setUserAiAndSpixEnabled(false);
        }
        setError(data.error || "Erreur lors de la génération.");
        return;
      }
      if (data.autoPublishedFirst) {
        setAutoPublishNotice(
          `Premier contenu « ${KIND_LABELS[kind]} » créé sur ce cours : automatiquement publié en PUBLIC pour toute la promo !`
        );
      }
      if (data.usedAi === false) {
        setAiNotice(
          "Ollama n'était pas joignable à l'instant : une version de secours extraite du texte a été générée."
        );
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

  async function handleRegenerate(art: StudioArtifactRow) {
    if (generatingKind || regeneratingId || !canGenerateAi) return;
    setRegeneratingId(art.id);
    setError(null);
    setAutoPublishNotice(null);
    setAiNotice(null);

    try {
      const res = await fetch("/api/studio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          replaceArtifactId: art.id,
          kind: art.kind,
          ueId,
          documentIds: art.documentId ? [art.documentId] : selectedDocIds,
          prompt: prompt.trim() || art.prompt || undefined,
          isPublic: art.isPublic,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        artifact?: StudioArtifactRow;
        usedAi?: boolean;
        error?: string;
        code?: string;
      };
      if (!res.ok || !data.artifact) {
        if (res.status === 403 || data.code === "USER_AI_DISABLED") {
          setUserAiEnabled(false);
          setUserAiAndSpixEnabled(false);
        }
        setError(data.error || "Erreur lors de la régénération.");
        return;
      }
      if (data.usedAi === false) {
        setAiNotice(
          "Ollama n'était pas joignable : version générée via l'extracteur structuré de notions et valeurs."
        );
      }
      setActiveArtifact(data.artifact);
      await fetchArtifacts();
    } finally {
      setRegeneratingId(null);
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
                const hasSummary = hasPublicKindForDoc(doc.id, "SUMMARY");
                const hasCards = hasPublicKindForDoc(doc.id, "FLASHCARDS");
                const hasQuiz = hasPublicKindForDoc(doc.id, "QUIZ");
                return (
                  <label
                    key={doc.id}
                    className={`flex cursor-pointer items-start gap-2.5 px-3.5 py-2.5 text-xs transition-colors ${
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
                      <div className="mt-1 flex flex-wrap gap-1 font-mono text-[9px] uppercase tracking-wider">
                        <span
                          className={`border px-1.5 py-0.5 ${
                            hasSummary
                              ? "border-forest/40 bg-forest/10 text-forest"
                              : "border-border bg-paper text-stone"
                          }`}
                        >
                          FICHE {hasSummary ? "✓" : "· NUIT"}
                        </span>
                        <span
                          className={`border px-1.5 py-0.5 ${
                            hasCards
                              ? "border-forest/40 bg-forest/10 text-forest"
                              : "border-border bg-paper text-stone"
                          }`}
                        >
                          CARTES {hasCards ? "✓" : "· NUIT"}
                        </span>
                        <span
                          className={`border px-1.5 py-0.5 ${
                            hasQuiz
                              ? "border-forest/40 bg-forest/10 text-forest"
                              : "border-border bg-paper text-stone"
                          }`}
                        >
                          QUIZ {hasQuiz ? "✓" : "· NUIT"}
                        </span>
                      </div>
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
                      <div className="mt-2 flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          disabled={
                            !canGenerateAi || Boolean(generatingKind || regeneratingId)
                          }
                          onClick={() => handleRegenerate(art)}
                          className="inline-flex items-center gap-1 border border-border bg-paper px-2 py-0.5 font-mono text-[9px] uppercase text-ink hover:border-ink disabled:opacity-50"
                          title={
                            canGenerateAi
                              ? "Régénérer avec le nouveau moteur IA"
                              : "Génération IA désactivée par l'administration"
                          }
                        >
                          <RefreshCw
                            className={`h-2.5 w-2.5 ${
                              regeneratingId === art.id ? "animate-spin" : ""
                            }`}
                          />
                          <span>
                            {regeneratingId === art.id
                              ? "GÉNÉRATION..."
                              : "REGÉNÉRER"}
                          </span>
                        </button>
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
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-ink" />
              <span className="font-mono text-xs font-bold uppercase tracking-wider text-ink">
                STUDIO IA · MODE COURS COMPLET PERMANENT
              </span>
            </div>
            <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
              {selectedDocIds.length} SOURCE
              {selectedDocIds.length > 1 ? "S" : ""} SÉLECTIONNÉE
              {selectedDocIds.length > 1 ? "S" : ""}
            </span>
          </div>

          {!canGenerateAi && (
            <div className="mb-3 flex items-start gap-2.5 border border-carmine/40 bg-carmine/10 px-3.5 py-2.5 font-mono text-[11px] leading-relaxed text-ink">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-carmine" />
              <span>
                <strong className="uppercase text-carmine">
                  GÉNÉRATION IA PAR LES UTILISATEURS TEMPORAIREMENT DÉSACTIVÉE
                  PAR L&apos;ADMINISTRATION
                </strong>{" "}
                — Toutes les fiches, flashcards et quiz enregistrés restent
                consultables ci-dessous.
              </span>
            </div>
          )}

          {error && (
            <div className="mb-3 border border-carmine/40 bg-carmine/10 px-3 py-2 font-mono text-xs text-carmine">
              {error}
            </div>
          )}

          {autoPublishNotice && (
            <div
              className="ara-animate-in mb-3 border border-forest bg-forest/10 px-3 py-2 font-mono text-xs text-forest"
              style={{ borderLeft: "3px solid #3B7A57" }}
            >
              {autoPublishNotice}
            </div>
          )}

          {aiNotice && (
            <div className="mb-3 border border-amber/60 bg-amber/10 px-3 py-2 font-mono text-xs text-ink">
              {aiNotice}
            </div>
          )}

          <div className="mb-3 space-y-2 border border-border bg-paper p-3">
            <label className="block font-mono text-[10px] font-bold uppercase tracking-wider text-ink">
              CONTEXTE &amp; CE QUE JE VEUX COMPRENDRE (MODE CUSTOM · OPTIONNEL)
            </label>
            <textarea
              rows={3}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Décrivez précisément ce que vous voulez travailler ou ne comprenez pas encore — ex : « Je bloque sur les mécanismes de compensation acido-basique », « Pièges entre l'anatomie du carpe et du tarse », « Cas pratiques de posologie »..."
              className="w-full border border-border bg-card px-3 py-2 text-sm text-ink placeholder:text-stone focus:border-ink focus:outline-none"
            />
            <div className="flex flex-wrap gap-1.5">
              {CONTEXT_CHIPS.map((chip) => (
                <button
                  key={chip}
                  type="button"
                  onClick={() => appendContextChip(chip)}
                  className="border border-border bg-card px-2 py-1 font-mono text-[9px] uppercase tracking-wider text-stone transition-colors hover:border-ink hover:bg-pinned hover:text-ink"
                >
                  + {chip}
                </button>
              ))}
            </div>
          </div>

          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-3">
            <label className="flex cursor-pointer items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-ink">
              <input
                type="checkbox"
                checked={wantPublic}
                onChange={(e) => setWantPublic(e.target.checked)}
                className="h-3.5 w-3.5 accent-ink"
              />
              <span>PARTAGER AVEC LA PROMO ({ueCode})</span>
            </label>
            <span className="font-mono text-[10px] text-stone">
              <strong className="text-ink">
                MODE COURS COMPLET TOUJOURS ACTIF
              </strong>{" "}
              : analyse l&apos;intégralité du polycopié (PUBLIC = partagé à
              l&apos;UE · PRIVÉ = visible par vous seul).
            </span>
          </div>

          {generatingKind && (
            <div className="mb-3 border border-amber/60 bg-pinned px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink">
              LECTURE DE TOUT LE POLYCOPIÉ PAR TRANCHES DE PAGES : SUR UN GROS
              POLY CELA PEUT DURER PLUSIEURS DIZAINES DE MINUTES (TRAITEMENT
              CÔTÉ SERVEUR, 100% LOCAL)...
            </div>
          )}

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <button
              type="button"
              disabled={
                !canGenerateAi ||
                Boolean(generatingKind) ||
                selectedDocIds.length === 0
              }
              onClick={() => handleGenerate("QUIZ")}
              className="flex flex-col items-center justify-center gap-1 border border-ink bg-ink px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-card hover:bg-ink/90 disabled:opacity-50"
            >
              <span className="inline-flex items-center gap-1.5">
                {generatingKind === "QUIZ" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <ListChecks className="h-3.5 w-3.5" />
                )}
                <span>QUIZ COMPLET</span>
              </span>
              <span className="text-[8px] opacity-80">
                {selectionMissingPublicKind("QUIZ")
                  ? "AUTO-PUBLIC · COURS COMPLET"
                  : wantPublic
                  ? "PUBLIC · COURS COMPLET"
                  : "PRIVÉ · COURS COMPLET"}
              </span>
            </button>

            <button
              type="button"
              disabled={
                !canGenerateAi ||
                Boolean(generatingKind) ||
                selectedDocIds.length === 0
              }
              onClick={() => handleGenerate("FLASHCARDS")}
              className="flex flex-col items-center justify-center gap-1 border border-border bg-paper px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink hover:bg-pinned disabled:opacity-50"
            >
              <span className="inline-flex items-center gap-1.5">
                {generatingKind === "FLASHCARDS" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Layers className="h-3.5 w-3.5" />
                )}
                <span>FLASHCARDS COMPLÈTES</span>
              </span>
              <span
                className={`text-[8px] ${
                  selectionMissingPublicKind("FLASHCARDS")
                    ? "text-forest"
                    : "text-stone"
                }`}
              >
                {selectionMissingPublicKind("FLASHCARDS")
                  ? "AUTO-PUBLIC · COURS COMPLET"
                  : wantPublic
                  ? "PUBLIC · COURS COMPLET"
                  : "PRIVÉ · COURS COMPLET"}
              </span>
            </button>

            <button
              type="button"
              disabled={
                !canGenerateAi ||
                Boolean(generatingKind) ||
                selectedDocIds.length === 0
              }
              onClick={() => handleGenerate("SUMMARY")}
              className="flex flex-col items-center justify-center gap-1 border border-border bg-paper px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink hover:bg-pinned disabled:opacity-50"
            >
              <span className="inline-flex items-center gap-1.5">
                {generatingKind === "SUMMARY" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <BookOpen className="h-3.5 w-3.5" />
                )}
                <span>FICHE COURS COMPLÈTE</span>
              </span>
              <span
                className={`text-[8px] ${
                  selectionMissingPublicKind("SUMMARY")
                    ? "text-forest"
                    : "text-stone"
                }`}
              >
                {selectionMissingPublicKind("SUMMARY")
                  ? "AUTO-PUBLIC · COURS COMPLET"
                  : wantPublic
                  ? "PUBLIC · COURS COMPLET"
                  : "PRIVÉ · COURS COMPLET"}
              </span>
            </button>

            <button
              type="button"
              disabled={
                !canGenerateAi ||
                Boolean(generatingKind) ||
                selectedDocIds.length === 0
              }
              onClick={() => handleGenerate("SVG_DIAGRAM")}
              className="flex flex-col items-center justify-center gap-1 border border-border bg-paper px-3 py-2.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink hover:bg-pinned disabled:opacity-50"
            >
              <span className="inline-flex items-center gap-1.5">
                {generatingKind === "SVG_DIAGRAM" ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <FileCode2 className="h-3.5 w-3.5" />
                )}
                <span>SCHÉMA .SVG</span>
              </span>
              <span
                className={`text-[8px] ${
                  selectionMissingPublicKind("SVG_DIAGRAM")
                    ? "text-forest"
                    : "text-stone"
                }`}
              >
                {selectionMissingPublicKind("SVG_DIAGRAM")
                  ? "AUTO-PUBLIC · COURS COMPLET"
                  : wantPublic
                  ? "PUBLIC · COURS COMPLET"
                  : "PRIVÉ · COURS COMPLET"}
              </span>
            </button>
          </div>
        </div>

        {/* Active Viewer */}
        {activeArtifact && parsedContent ? (
          <div className="space-y-2">
            {(activeArtifact.userId === session?.user?.id ||
              session?.user?.globalRole === "YEAR_ADMIN") && (
              <div className="flex flex-wrap items-center justify-between gap-2 border border-border bg-paper px-3 py-1.5">
                <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
                  {activeArtifact.isPublic
                    ? "VERSION PUBLIQUE (PROMO)"
                    : "VERSION PRIVÉE CUSTOM"}{" "}
                  · PAR {activeArtifact.user.name}
                </span>
                <button
                  type="button"
                  disabled={
                    !canGenerateAi || Boolean(generatingKind || regeneratingId)
                  }
                  onClick={() => handleRegenerate(activeArtifact)}
                  className="inline-flex items-center gap-1.5 border border-ink bg-card px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink hover:bg-pinned disabled:opacity-50"
                >
                  <RefreshCw
                    className={`h-3 w-3 ${
                      regeneratingId === activeArtifact.id
                        ? "animate-spin"
                        : ""
                    }`}
                  />
                  <span>
                    {regeneratingId === activeArtifact.id
                      ? "RÉGÉNÉRATION EN COURS..."
                      : "REGÉNÉRER CE CONTENU"}
                  </span>
                </button>
              </div>
            )}
            <StudioArtifactViewer
              key={activeArtifact.id}
              title={activeArtifact.title}
              content={parsedContent}
              onOpenSource={onOpenSource}
            />
          </div>
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
