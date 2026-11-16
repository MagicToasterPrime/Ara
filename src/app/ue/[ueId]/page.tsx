"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useSession } from "next-auth/react";
import {
  ArrowLeft,
  ArrowUp,
  CheckCircle2,
  ExternalLink,
  FileText,
  FolderPlus,
  MessageSquare,
  PanelRightClose,
  PanelRightOpen,
  PenTool,
  Pin,
  PinOff,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import {
  HyacinthePanel,
  type HyacintheSource,
} from "@/components/HyacinthePanel";

interface DocItem {
  id: string;
  chapterId: string;
  authorId: string;
  author: {
    id: string;
    name: string;
    email: string;
    globalRole: string;
  };
  title: string;
  fileName: string;
  mimeType: string;
  fileSize: number;
  category: "OFFICIAL_COURSE" | "STUDENT_NOTE";
  isPinned: boolean;
  isIndexed: boolean;
  pageCount: number;
  createdAt: string;
  upvoteCount: number;
  hasUpvoted: boolean;
}

interface ChapterItem {
  id: string;
  ueId: string;
  title: string;
  order: number;
  documents: DocItem[];
}

interface UEDetail {
  id: string;
  code: string;
  title: string;
  description: string;
  semester: string;
  accentColor: string;
  roles: Array<{
    id: string;
    user: { id: string; name: string; email: string };
  }>;
  chapters: ChapterItem[];
  channels: Array<{ id: string; name: string; type: string }>;
  whiteboards: Array<{ id: string; title: string; updatedAt: string }>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} Mo`;
}

function UEWorkspaceContent() {
  const params = useParams<{ ueId: string }>();
  const searchParams = useSearchParams();
  const { data: session } = useSession();

  const ueId = params.ueId;
  const initialDocParam = searchParams.get("doc");
  const initialPageParam = Number.parseInt(searchParams.get("page") || "1", 10);

  const [ue, setUe] = useState<UEDetail | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedChapterId, setSelectedChapterId] = useState<string>("ALL");
  const [validatedOnly, setValidatedOnly] = useState(false);
  const [hyacintheOpen, setHyacintheOpen] = useState(true);

  const [activeDoc, setActiveDoc] = useState<DocItem | null>(null);
  const [activePage, setActivePage] = useState<number>(1);

  // Chapter form
  const [newChapterTitle, setNewChapterTitle] = useState("");
  const [creatingChapter, setCreatingChapter] = useState(false);

  // Upload form
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadChapterId, setUploadChapterId] = useState("");
  const [uploadTitle, setUploadTitle] = useState("");
  const [uploadCategory, setUploadCategory] = useState<
    "OFFICIAL_COURSE" | "STUDENT_NOTE"
  >("STUDENT_NOTE");
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadFeedback, setUploadFeedback] = useState<string | null>(null);

  const fetchUE = useCallback(async () => {
    try {
      const res = await fetch(`/api/ues/${ueId}`, { cache: "no-store" });
      if (!res.ok) {
        setError("Impossible de charger cette UE.");
        return;
      }
      const data = (await res.json()) as { ue: UEDetail; canManage: boolean };
      setUe(data.ue);
      setCanManage(data.canManage);
      setUploadChapterId((prev) => prev || data.ue.chapters[0]?.id || "");
    } catch {
      setError("Erreur réseau lors du chargement de l'UE.");
    } finally {
      setLoading(false);
    }
  }, [ueId]);

  useEffect(() => {
    void fetchUE();
  }, [fetchUE]);

  // Open doc from URL query params (?doc=...&page=...)
  useEffect(() => {
    if (!ue || !initialDocParam) return;
    const allDocs = ue.chapters.flatMap((c) => c.documents);
    const match = allDocs.find((d) => d.id === initialDocParam);
    if (match) {
      setActiveDoc(match);
      setActivePage(
        Number.isFinite(initialPageParam) && initialPageParam > 0
          ? initialPageParam
          : 1
      );
    }
  }, [ue, initialDocParam, initialPageParam]);

  const visibleDocuments = useMemo(() => {
    if (!ue) return [];
    if (selectedChapterId === "ALL") {
      return ue.chapters.flatMap((c) => c.documents);
    }
    const ch = ue.chapters.find((c) => c.id === selectedChapterId);
    return ch ? ch.documents : [];
  }, [ue, selectedChapterId]);

  const officialDocs = useMemo(
    () => visibleDocuments.filter((d) => d.category === "OFFICIAL_COURSE"),
    [visibleDocuments]
  );

  const studentNotes = useMemo(
    () =>
      visibleDocuments.filter(
        (d) =>
          d.category === "STUDENT_NOTE" && (!validatedOnly || d.isPinned)
      ),
    [visibleDocuments, validatedOnly]
  );

  async function handleCreateChapter(e: React.FormEvent) {
    e.preventDefault();
    if (!newChapterTitle.trim() || creatingChapter) return;
    setCreatingChapter(true);
    try {
      const res = await fetch(`/api/ues/${ueId}/chapters`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newChapterTitle.trim() }),
      });
      if (res.ok) {
        setNewChapterTitle("");
        await fetchUE();
      }
    } finally {
      setCreatingChapter(false);
    }
  }

  async function handleDeleteChapter(chapterId: string) {
    if (!confirm("Supprimer ce chapitre et tous ses documents associés ?")) {
      return;
    }
    const res = await fetch(
      `/api/ues/${ueId}/chapters?chapterId=${encodeURIComponent(chapterId)}`,
      { method: "DELETE" }
    );
    if (res.ok) {
      if (selectedChapterId === chapterId) setSelectedChapterId("ALL");
      await fetchUE();
    }
  }

  async function handleUpload(e: React.FormEvent) {
    e.preventDefault();
    if (!uploadChapterId || !uploadFile || uploading) return;

    setUploading(true);
    setUploadFeedback(null);

    try {
      const formData = new FormData();
      formData.append("chapterId", uploadChapterId);
      formData.append("title", uploadTitle.trim());
      formData.append("category", uploadCategory);
      formData.append("file", uploadFile);

      const res = await fetch("/api/documents", {
        method: "POST",
        body: formData,
      });

      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        indexing?: { indexed: boolean; chunkCount: number };
      };

      if (!res.ok) {
        setUploadFeedback(data.error || "Échec de l'upload.");
        return;
      }

      setUploadTitle("");
      setUploadFile(null);
      setUploadOpen(false);
      await fetchUE();
    } catch {
      setUploadFeedback("Erreur réseau lors de l'envoi du PDF.");
    } finally {
      setUploading(false);
    }
  }

  async function handleToggleUpvote(docId: string) {
    const res = await fetch(`/api/documents/${docId}/upvote`, {
      method: "POST",
    });
    if (res.ok) {
      await fetchUE();
    }
  }

  async function handleTogglePin(doc: DocItem) {
    const res = await fetch(`/api/documents/${doc.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPinned: !doc.isPinned }),
    });
    if (res.ok) {
      await fetchUE();
    }
  }

  async function handleDeleteDoc(docId: string) {
    if (!confirm("Supprimer définitivement ce PDF ?")) return;
    const res = await fetch(`/api/documents/${docId}`, {
      method: "DELETE",
    });
    if (res.ok) {
      if (activeDoc?.id === docId) setActiveDoc(null);
      await fetchUE();
    }
  }

  function handleOpenHyacintheSource(source: HyacintheSource) {
    if (!ue) return;
    if (source.ueId !== ue.id) return;
    const allDocs = ue.chapters.flatMap((c) => c.documents);
    const found = allDocs.find((d) => d.id === source.documentId);
    if (found) {
      setActiveDoc(found);
      setActivePage(source.pageNumber);
    }
  }

  if (loading) {
    return (
      <div className="border border-border bg-card p-8 font-mono text-xs uppercase tracking-wider text-stone">
        CHARGEMENT DE L&apos;ESPACE UE...
      </div>
    );
  }

  if (error || !ue) {
    return (
      <div className="border border-border bg-card p-8">
        <p className="font-mono text-xs uppercase tracking-wider text-carmine">
          {error || "UE INTROUVABLE"}
        </p>
        <Link
          href="/"
          className="mt-4 inline-flex items-center gap-2 border border-border bg-paper px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          <span>RETOUR AUX UE</span>
        </Link>
      </div>
    );
  }

  const primaryChannel = ue.channels[0];

  return (
    <div className="space-y-4">
      {/* UE Top Masthead */}
      <div
        className="flex flex-wrap items-center justify-between gap-4 border border-border bg-card p-4"
        style={{ borderTop: `3px solid ${ue.accentColor || "#D99B26"}` }}
      >
        <div className="flex items-start gap-3">
          <Link
            href="/"
            className="mt-0.5 flex h-8 w-8 items-center justify-center border border-border bg-paper text-ink hover:bg-pinned"
            title="Retour à la liste des UE"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-xs font-semibold uppercase tracking-wider text-stone">
                {ue.code} · {ue.semester}
              </span>
              {ue.roles.map((r) => (
                <span
                  key={r.id}
                  className="bg-badge-bg px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-badge-text"
                >
                  RESP: {r.user.name}
                </span>
              ))}
              {canManage && (
                <span className="border border-ink bg-ink px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-card">
                  DROITS GESTIONNAIRE
                </span>
              )}
            </div>
            <h1 className="mt-1 text-xl font-bold uppercase tracking-tight text-ink">
              {ue.title}
            </h1>
            {ue.description && (
              <p className="mt-1 text-sm text-stone">{ue.description}</p>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => {
              setUploadCategory(canManage ? "OFFICIAL_COURSE" : "STUDENT_NOTE");
              setUploadOpen((prev) => !prev);
            }}
            className="inline-flex items-center gap-1.5 border border-ink bg-ink px-3.5 py-2 font-mono text-xs uppercase tracking-wider text-card hover:bg-ink/90"
          >
            <Upload className="h-3.5 w-3.5" />
            <span>DÉPOSER UN PDF</span>
          </button>

          <button
            type="button"
            onClick={() => setHyacintheOpen((prev) => !prev)}
            className="inline-flex items-center gap-1.5 border border-border bg-paper px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink hover:bg-pinned"
          >
            {hyacintheOpen ? (
              <PanelRightClose className="h-3.5 w-3.5" />
            ) : (
              <PanelRightOpen className="h-3.5 w-3.5" />
            )}
            <span>HYACINTHE IA</span>
          </button>
        </div>
      </div>

      {/* Upload Form Drawer */}
      {uploadOpen && (
        <form
          onSubmit={handleUpload}
          className="border border-ink bg-card p-5"
        >
          <div className="mb-4 flex items-center justify-between border-b border-border pb-3">
            <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
              TÉLÉVERSER UN DOCUMENT PDF (INDEXATION RAG AUTOMATIQUE)
            </span>
            <button
              type="button"
              onClick={() => setUploadOpen(false)}
              className="text-stone hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
          </div>

          {uploadFeedback && (
            <div className="mb-4 border border-carmine/40 bg-carmine/10 px-3 py-2 font-mono text-xs text-carmine">
              {uploadFeedback}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-4">
            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                CHAPITRE CIBLE
              </label>
              <select
                required
                value={uploadChapterId}
                onChange={(e) => setUploadChapterId(e.target.value)}
                className="w-full border border-border bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
              >
                {ue.chapters.length === 0 && (
                  <option value="">Aucun chapitre</option>
                )}
                {ue.chapters.map((ch) => (
                  <option key={ch.id} value={ch.id}>
                    {ch.title}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                CATÉGORIE
              </label>
              <select
                value={uploadCategory}
                onChange={(e) =>
                  setUploadCategory(
                    e.target.value === "OFFICIAL_COURSE"
                      ? "OFFICIAL_COURSE"
                      : "STUDENT_NOTE"
                  )
                }
                className="w-full border border-border bg-paper px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink focus:border-ink focus:outline-none"
              >
                <option value="STUDENT_NOTE">NOTE ÉTUDIANTE</option>
                {canManage && (
                  <option value="OFFICIAL_COURSE">COURS OFFICIEL</option>
                )}
              </select>
            </div>

            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                TITRE DU DOCUMENT
              </label>
              <input
                type="text"
                value={uploadTitle}
                onChange={(e) => setUploadTitle(e.target.value)}
                placeholder="Ex : Ostéologie membre thoracique"
                className="w-full border border-border bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
              />
            </div>

            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                FICHIER PDF
              </label>
              <input
                type="file"
                required
                accept="application/pdf,.pdf"
                onChange={(e) => setUploadFile(e.target.files?.[0] || null)}
                className="w-full border border-border bg-paper px-2 py-1.5 font-mono text-xs text-ink"
              />
            </div>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setUploadOpen(false)}
              className="border border-border bg-paper px-4 py-2 font-mono text-xs uppercase tracking-wider text-ink"
            >
              ANNULER
            </button>
            <button
              type="submit"
              disabled={uploading || !uploadFile || !uploadChapterId}
              className="border border-ink bg-ink px-5 py-2 font-mono text-xs uppercase tracking-wider text-card disabled:opacity-50"
            >
              {uploading ? "INDEXATION & ENVOI..." : "PUBLIER LE PDF"}
            </button>
          </div>
        </form>
      )}

      {/* 3-Column Workspace */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        {/* Left: Chapters & Tools */}
        <aside className="space-y-4 lg:col-span-3">
          <div className="border border-border bg-card">
            <div className="border-b border-border bg-paper px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider text-ink">
              CHAPITRES ({ue.chapters.length})
            </div>

            <div className="divide-y divide-border">
              <button
                type="button"
                onClick={() => setSelectedChapterId("ALL")}
                className={`flex w-full items-center justify-between px-4 py-2.5 text-left font-mono text-xs uppercase tracking-wider transition-colors ${
                  selectedChapterId === "ALL"
                    ? "bg-pinned font-semibold text-ink"
                    : "bg-card text-stone hover:bg-paper hover:text-ink"
                }`}
              >
                <span>TOUS LES CHAPITRES</span>
                <span>
                  {ue.chapters.reduce((acc, c) => acc + c.documents.length, 0)}
                </span>
              </button>

              {ue.chapters.map((ch) => (
                <div
                  key={ch.id}
                  className={`flex items-center justify-between gap-2 px-4 py-2.5 ${
                    selectedChapterId === ch.id ? "bg-pinned" : "bg-card"
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedChapterId(ch.id)}
                    className="min-w-0 flex-1 text-left text-sm font-medium text-ink"
                  >
                    <span className="block truncate">{ch.title}</span>
                    <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
                      {ch.documents.length} PDF
                    </span>
                  </button>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => handleDeleteChapter(ch.id)}
                      title="Supprimer ce chapitre"
                      className="text-stone hover:text-carmine"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              ))}
            </div>

            {canManage && (
              <form
                onSubmit={handleCreateChapter}
                className="border-t border-border bg-paper p-3"
              >
                <div className="flex gap-1.5">
                  <input
                    type="text"
                    value={newChapterTitle}
                    onChange={(e) => setNewChapterTitle(e.target.value)}
                    placeholder="Nouveau chapitre..."
                    className="min-w-0 flex-1 border border-border bg-card px-2.5 py-1.5 text-xs text-ink focus:border-ink focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={creatingChapter || !newChapterTitle.trim()}
                    title="Ajouter le chapitre"
                    className="border border-ink bg-ink px-2.5 py-1.5 text-card disabled:opacity-50"
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* Quick Channels & Whiteboards */}
          <div className="border border-border bg-card p-4">
            <p className="mb-2.5 font-mono text-[11px] font-semibold uppercase tracking-wider text-stone">
              OUTILS COLLABORATIFS UE
            </p>
            <div className="space-y-2">
              {primaryChannel && (
                <Link
                  href={`/chat?channelId=${primaryChannel.id}`}
                  className="flex items-center justify-between border border-border bg-paper px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink hover:bg-pinned"
                >
                  <span className="inline-flex items-center gap-2">
                    <MessageSquare className="h-3.5 w-3.5" />
                    {primaryChannel.name}
                  </span>
                  <ExternalLink className="h-3 w-3 text-stone" />
                </Link>
              )}

              <Link
                href={`/whiteboard?ueId=${ue.id}`}
                className="flex items-center justify-between border border-border bg-paper px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink hover:bg-pinned"
              >
                <span className="inline-flex items-center gap-2">
                  <PenTool className="h-3.5 w-3.5" />
                  TABLEAUX ({ue.whiteboards.length})
                </span>
                <ExternalLink className="h-3 w-3 text-stone" />
              </Link>
            </div>
          </div>
        </aside>

        {/* Center: Documents + Native PDF Reader */}
        <section
          className={`space-y-4 ${
            hyacintheOpen ? "lg:col-span-5" : "lg:col-span-9"
          }`}
        >
          {/* Integrated PDF Reader */}
          {activeDoc && (
            <div className="border border-ink bg-card">
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-ink px-4 py-2.5 text-card">
                <div className="min-w-0">
                  <p className="truncate font-mono text-xs font-semibold uppercase tracking-wider">
                    LECTEUR PDF · {activeDoc.title}
                  </p>
                  <p className="font-mono text-[10px] uppercase tracking-wider text-card/75">
                    {activeDoc.fileName} · PAGE {activePage} /{" "}
                    {activeDoc.pageCount}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <a
                    href={`/api/files/${activeDoc.id}#page=${activePage}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 border border-card/30 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-card hover:bg-card/10"
                  >
                    <ExternalLink className="h-3 w-3" />
                    <span>NOUVEL ONGLET</span>
                  </a>
                  <button
                    type="button"
                    onClick={() => setActiveDoc(null)}
                    className="border border-card/30 px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-card hover:bg-card/10"
                  >
                    FERMER
                  </button>
                </div>
              </div>

              <iframe
                key={`${activeDoc.id}-p-${activePage}`}
                src={`/api/files/${activeDoc.id}#page=${activePage}`}
                title={activeDoc.title}
                className="h-[580px] w-full bg-paper"
              />
            </div>
          )}

          {/* Official Courses Section */}
          <div className="border border-border bg-card">
            <div className="flex items-center justify-between border-b border-border bg-paper px-4 py-2.5">
              <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                COURS OFFICIELS ({officialDocs.length})
              </span>
              <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
                SUPPORTS MAGISTRAUX &amp; POLYCOPIÉS
              </span>
            </div>

            {officialDocs.length === 0 ? (
              <div className="p-6 text-center">
                <p className="font-mono text-xs uppercase tracking-wider text-stone">
                  AUCUN COURS OFFICIEL DANS CETTE SÉLECTION.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {officialDocs.map((doc) => {
                  const isActive = activeDoc?.id === doc.id;
                  const canDelete =
                    canManage || doc.authorId === session?.user?.id;
                  return (
                    <div
                      key={doc.id}
                      className={`flex flex-wrap items-center justify-between gap-3 p-4 ${
                        isActive ? "bg-pinned" : "bg-card"
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <FileText className="h-4 w-4 shrink-0 text-ink" />
                          <h3 className="truncate text-sm font-bold text-ink">
                            {doc.title}
                          </h3>
                          <span
                            className={`px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider ${
                              doc.isIndexed
                                ? "bg-badge-bg text-badge-text"
                                : "border border-border bg-paper text-stone"
                            }`}
                          >
                            {doc.isIndexed ? "RAG INDEXÉ" : "NON INDEXÉ"}
                          </span>
                        </div>
                        <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-stone">
                          {doc.fileName} · {doc.pageCount} PAGES ·{" "}
                          {formatBytes(doc.fileSize)}
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setActiveDoc(doc);
                            setActivePage(1);
                          }}
                          className="border border-ink bg-ink px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-card hover:bg-ink/90"
                        >
                          LIRE PDF
                        </button>
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => handleDeleteDoc(doc.id)}
                            title="Supprimer"
                            className="border border-border bg-paper p-1.5 text-stone hover:border-carmine hover:text-carmine"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Student Notes Section */}
          <div className="border border-border bg-card">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-paper px-4 py-2.5">
              <span className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                NOTES ÉTUDIANTES ({studentNotes.length})
              </span>

              <button
                type="button"
                onClick={() => setValidatedOnly((prev) => !prev)}
                className={`inline-flex items-center gap-1.5 border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${
                  validatedOnly
                    ? "border-badge-text bg-badge-bg text-badge-text"
                    : "border-border bg-card text-stone hover:text-ink"
                }`}
              >
                <CheckCircle2 className="h-3 w-3" />
                <span>VALIDÉES UNIQUEMENT</span>
              </button>
            </div>

            {studentNotes.length === 0 ? (
              <div className="p-6 text-center">
                <p className="font-mono text-xs uppercase tracking-wider text-stone">
                  AUCUNE NOTE ÉTUDIANTE{" "}
                  {validatedOnly ? "VALIDÉE " : ""}POUR L&apos;INSTANT.
                </p>
              </div>
            ) : (
              <div className="divide-y divide-border">
                {studentNotes.map((doc) => {
                  const isActive = activeDoc?.id === doc.id;
                  const canDelete =
                    canManage || doc.authorId === session?.user?.id;
                  return (
                    <div
                      key={doc.id}
                      className={`flex flex-wrap items-center justify-between gap-3 p-4 ${
                        isActive || doc.isPinned ? "bg-pinned" : "bg-card"
                      }`}
                    >
                      <div className="flex min-w-0 flex-1 items-start gap-3">
                        {/* Upvote Button */}
                        <button
                          type="button"
                          onClick={() => handleToggleUpvote(doc.id)}
                          className={`flex w-12 shrink-0 flex-col items-center justify-center border py-1 font-mono text-xs transition-colors ${
                            doc.hasUpvoted
                              ? "border-ink bg-ink text-card"
                              : "border-border bg-paper text-ink hover:border-ink"
                          }`}
                          title="Voter pour cette fiche"
                        >
                          <ArrowUp className="h-3 w-3" />
                          <span className="text-[11px] font-bold">
                            {doc.upvoteCount}
                          </span>
                        </button>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <h3 className="truncate text-sm font-bold text-ink">
                              {doc.title}
                            </h3>
                            {doc.isPinned && (
                              <span className="bg-badge-bg px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-badge-text">
                                VALIDÉ PAR RESP. UE
                              </span>
                            )}
                          </div>
                          <p className="mt-1 font-mono text-[11px] uppercase tracking-wider text-stone">
                            PAR {doc.author.name} · {doc.fileName} ·{" "}
                            {doc.pageCount} PAGES
                          </p>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setActiveDoc(doc);
                            setActivePage(1);
                          }}
                          className="border border-border bg-paper px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink hover:border-ink hover:bg-card"
                        >
                          LIRE PDF
                        </button>

                        {canManage && (
                          <button
                            type="button"
                            onClick={() => handleTogglePin(doc)}
                            title={
                              doc.isPinned
                                ? "Retirer la validation"
                                : "Épingler / Valider par Resp. UE"
                            }
                            className={`border p-1.5 ${
                              doc.isPinned
                                ? "border-badge-text bg-badge-bg text-badge-text"
                                : "border-border bg-paper text-stone hover:text-ink"
                            }`}
                          >
                            {doc.isPinned ? (
                              <PinOff className="h-3.5 w-3.5" />
                            ) : (
                              <Pin className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}

                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => handleDeleteDoc(doc.id)}
                            title="Supprimer"
                            className="border border-border bg-paper p-1.5 text-stone hover:border-carmine hover:text-carmine"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        {/* Right: Retractable Hyacinthe Panel */}
        {hyacintheOpen && (
          <aside className="h-[680px] border border-border bg-card lg:col-span-4">
            <HyacinthePanel
              fixedUeId={ue.id}
              fixedUeLabel={`${ue.code} · ${ue.title}`}
              compact
              onOpenSource={handleOpenHyacintheSource}
            />
          </aside>
        )}
      </div>
    </div>
  );
}

export default function UEPage() {
  return (
    <AppShell>
      <Suspense
        fallback={
          <div className="border border-border bg-card p-8 font-mono text-xs uppercase tracking-wider text-stone">
            CHARGEMENT DE L&apos;UE...
          </div>
        }
      >
        <UEWorkspaceContent />
      </Suspense>
    </AppShell>
  );
}
