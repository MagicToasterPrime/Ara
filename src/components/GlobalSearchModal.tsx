"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  BookOpen,
  FileText,
  HelpCircle,
  Loader2,
  PenTool,
  Search,
  X,
} from "lucide-react";

interface SearchResultsPayload {
  ues: Array<{
    id: string;
    code: string;
    title: string;
    semester: string;
    classLevel: string;
  }>;
  documents: Array<{
    id: string;
    title: string;
    fileName: string;
    pageCount: number;
    chapterTitle: string;
    ueId: string;
    ueCode: string;
  }>;
  chunks: Array<{
    id: string;
    documentId: string;
    documentTitle: string;
    fileName: string;
    pageNumber: number;
    chapterTitle: string;
    ueId: string;
    ueCode: string;
    snippet: string;
  }>;
  quizzes: Array<{
    id: string;
    title: string;
    ueId: string | null;
    ue: { id: string; code: string } | null;
  }>;
  whiteboards: Array<{
    id: string;
    title: string;
    ue: { id: string; code: string } | null;
  }>;
}

interface GlobalSearchModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function GlobalSearchModal({ isOpen, onClose }: GlobalSearchModalProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<SearchResultsPayload>({
    ues: [],
    documents: [],
    chunks: [],
    quizzes: [],
    whiteboards: [],
  });

  useEffect(() => {
    if (isOpen) {
      setTimeout(() => inputRef.current?.focus(), 30);
    } else {
      setQuery("");
    }
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const q = query.trim();
    if (q.length < 2) {
      setResults({
        ues: [],
        documents: [],
        chunks: [],
        quizzes: [],
        whiteboards: [],
      });
      setLoading(false);
      return;
    }

    setLoading(true);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(q)}`,
          { signal: controller.signal, cache: "no-store" }
        );
        if (res.ok) {
          const data = (await res.json()) as SearchResultsPayload;
          setResults(data);
        }
      } catch {
        // Ignore abort
      } finally {
        setLoading(false);
      }
    }, 200);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, isOpen]);

  if (!isOpen) return null;

  function navigateAndClose(href: string) {
    onClose();
    router.push(href);
  }

  const totalCount =
    results.ues.length +
    results.documents.length +
    results.chunks.length +
    results.quizzes.length +
    results.whiteboards.length;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/50 px-4 pt-16 sm:pt-20"
      onClick={onClose}
    >
      <div
        className="w-full max-w-3xl border border-ink bg-card"
        style={{ borderTop: "3px solid #D99B26" }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Search Bar */}
        <div className="flex items-center gap-3 border-b border-border bg-paper px-4 py-3">
          {loading ? (
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-ink" />
          ) : (
            <Search className="h-4 w-4 shrink-0 text-stone" />
          )}
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Rechercher un terme dans tous les PDF, UE, quiz ou tableaux blancs..."
            className="flex-1 bg-transparent text-sm text-ink placeholder:text-stone focus:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            className="border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-stone hover:border-ink hover:text-ink"
          >
            ÉCHAP <X className="ml-0.5 inline h-3 w-3" />
          </button>
        </div>

        {/* Results Panel */}
        <div className="max-h-[65vh] divide-y divide-border overflow-y-auto">
          {query.trim().length < 2 ? (
            <div className="p-8 text-center">
              <p className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                INDEXATION GLOBALE · INTÉRIEUR DES POLYCOPIÉS PDF &amp; ESPACES
              </p>
              <p className="mt-1.5 font-mono text-[11px] uppercase tracking-wider text-stone">
                TAPEZ AU MOINS 2 CARACTÈRES (EX. : « GLASGOW », « HÉMOLYSE »,
                « UE-101 »)
              </p>
            </div>
          ) : totalCount === 0 && !loading ? (
            <div className="p-8 text-center font-mono text-xs uppercase tracking-wider text-stone">
              AUCUN RÉSULTAT POUR « {query.trim().toUpperCase()} ».
            </div>
          ) : (
            <>
              {/* Inside PDF pages (DocumentChunk) */}
              {results.chunks.length > 0 && (
                <div className="p-3">
                  <p className="mb-2 px-1 font-mono text-[10px] font-bold uppercase tracking-wider text-stone">
                    DANS LE TEXTE DES COURS PDF ({results.chunks.length})
                  </p>
                  <div className="space-y-1.5">
                    {results.chunks.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() =>
                          navigateAndClose(
                            `/ue/${c.ueId}?doc=${encodeURIComponent(
                              c.documentId
                            )}&page=${c.pageNumber}`
                          )
                        }
                        className="flex w-full items-start justify-between gap-3 border border-border bg-paper p-2.5 text-left hover:border-ink hover:bg-pinned"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider">
                            <span className="bg-badge-bg px-1.5 py-0.5 font-bold text-badge-text">
                              {c.ueCode}
                            </span>
                            <span className="font-semibold text-ink">
                              {c.documentTitle}
                            </span>
                            <span className="border border-ink bg-ink px-1.5 py-0.5 font-bold text-card">
                              PAGE {c.pageNumber}
                            </span>
                          </div>
                          <p className="mt-1 line-clamp-2 text-xs text-stone">
                            {c.snippet}
                          </p>
                        </div>
                        <ArrowRight className="mt-1 h-3.5 w-3.5 shrink-0 text-stone" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* UEs */}
              {results.ues.length > 0 && (
                <div className="p-3">
                  <p className="mb-2 px-1 font-mono text-[10px] font-bold uppercase tracking-wider text-stone">
                    UNITÉS D&apos;ENSEIGNEMENT ({results.ues.length})
                  </p>
                  <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {results.ues.map((ue) => (
                      <button
                        key={ue.id}
                        type="button"
                        onClick={() => navigateAndClose(`/ue/${ue.id}`)}
                        className="flex items-center justify-between gap-2 border border-border bg-paper p-2.5 text-left hover:border-ink hover:bg-pinned"
                      >
                        <div className="min-w-0">
                          <p className="font-mono text-[10px] font-bold uppercase text-badge-text">
                            {ue.code} · {ue.classLevel} · {ue.semester}
                          </p>
                          <p className="truncate text-xs font-bold text-ink">
                            {ue.title}
                          </p>
                        </div>
                        <BookOpen className="h-3.5 w-3.5 shrink-0 text-stone" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Documents by Title */}
              {results.documents.length > 0 && (
                <div className="p-3">
                  <p className="mb-2 px-1 font-mono text-[10px] font-bold uppercase tracking-wider text-stone">
                    FICHIERS PDF ({results.documents.length})
                  </p>
                  <div className="space-y-1">
                    {results.documents.map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        onClick={() =>
                          navigateAndClose(
                            `/ue/${d.ueId}?doc=${encodeURIComponent(d.id)}&page=1`
                          )
                        }
                        className="flex w-full items-center justify-between gap-2 border border-border bg-paper px-3 py-2 text-left hover:border-ink hover:bg-pinned"
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <FileText className="h-3.5 w-3.5 shrink-0 text-ink" />
                          <span className="truncate text-xs font-semibold text-ink">
                            {d.title}
                          </span>
                          <span className="font-mono text-[10px] uppercase text-stone">
                            ({d.ueCode} · {d.pageCount}P)
                          </span>
                        </div>
                        <ArrowRight className="h-3.5 w-3.5 shrink-0 text-stone" />
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Quizzes & Whiteboards */}
              {(results.quizzes.length > 0 || results.whiteboards.length > 0) && (
                <div className="grid grid-cols-1 gap-3 p-3 sm:grid-cols-2">
                  {results.quizzes.length > 0 && (
                    <div>
                      <p className="mb-1.5 px-1 font-mono text-[10px] font-bold uppercase tracking-wider text-stone">
                        QUIZ &amp; SCHÉMAS ({results.quizzes.length})
                      </p>
                      <div className="space-y-1">
                        {results.quizzes.map((qz) => (
                          <button
                            key={qz.id}
                            type="button"
                            onClick={() =>
                              navigateAndClose(
                                qz.ueId ? `/ue/${qz.ueId}?tab=studio` : "/revisions"
                              )
                            }
                            className="flex w-full items-center justify-between gap-2 border border-border bg-paper px-2.5 py-2 text-left hover:border-ink"
                          >
                            <span className="truncate text-xs font-semibold text-ink">
                              {qz.title}
                            </span>
                            <HelpCircle className="h-3.5 w-3.5 shrink-0 text-stone" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}

                  {results.whiteboards.length > 0 && (
                    <div>
                      <p className="mb-1.5 px-1 font-mono text-[10px] font-bold uppercase tracking-wider text-stone">
                        TABLEAUX BLANCS ({results.whiteboards.length})
                      </p>
                      <div className="space-y-1">
                        {results.whiteboards.map((wb) => (
                          <button
                            key={wb.id}
                            type="button"
                            onClick={() =>
                              navigateAndClose(`/whiteboard/${wb.id}`)
                            }
                            className="flex w-full items-center justify-between gap-2 border border-border bg-paper px-2.5 py-2 text-left hover:border-ink"
                          >
                            <span className="truncate text-xs font-semibold text-ink">
                              {wb.title}
                            </span>
                            <PenTool className="h-3.5 w-3.5 shrink-0 text-stone" />
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
