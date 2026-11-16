"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist/types/src/display/api";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  List,
  Loader2,
  Maximize2,
  Minimize2,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";

interface DocumentChunkPreview {
  id: string;
  pageNumber: number;
  content: string;
}

export interface CustomPdfReaderProps {
  documentId: string;
  title: string;
  fileName: string;
  initialPage?: number;
  pageCountHint?: number;
  onPageChange?: (page: number, totalPages: number) => void;
  onClose: () => void;
}

export function CustomPdfReader({
  documentId,
  title,
  fileName,
  initialPage = 1,
  pageCountHint = 1,
  onPageChange,
  onClose,
}: CustomPdfReaderProps) {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [totalPages, setTotalPages] = useState<number>(pageCountHint);
  const [currentPage, setCurrentPage] = useState<number>(Math.max(1, initialPage));
  const [pageInput, setPageInput] = useState<string>(String(Math.max(1, initialPage)));

  const [zoomMode, setZoomMode] = useState<"FIT" | "MANUAL">("FIT");
  const [manualScale, setManualScale] = useState<number>(1.1);
  const [containerWidth, setContainerWidth] = useState<number>(760);

  const [loadingDoc, setLoadingDoc] = useState<boolean>(true);
  const [renderingPage, setRenderingPage] = useState<boolean>(false);
  const [docError, setDocError] = useState<string | null>(null);

  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<"CANVAS" | "TEXT">("CANVAS");
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  const [chunks, setChunks] = useState<DocumentChunkPreview[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [livePageText, setLivePageText] = useState<string>("");

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  // Sync external initialPage updates (e.g. clicking a Spix citation badge)
  useEffect(() => {
    const safe = Math.max(1, Math.min(initialPage, totalPages || initialPage));
    setCurrentPage(safe);
    setPageInput(String(safe));
  }, [initialPage, totalPages]);

  // Configure PDF.js worker once
  useEffect(() => {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
  }, []);

  // Observe canvas viewport width for FIT mode
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const updateWidth = () => {
      const next = Math.max(320, el.clientWidth - 48);
      setContainerWidth(next);
    };
    updateWidth();

    const observer = new ResizeObserver(updateWidth);
    observer.observe(el);
    return () => observer.disconnect();
  }, [sidebarOpen, isFullscreen]);

  // Load PDF binary via pdf.js
  useEffect(() => {
    let cancelled = false;
    setLoadingDoc(true);
    setDocError(null);
    setPdfDoc(null);

    const loadingTask = pdfjsLib.getDocument({
      url: `/api/files/${documentId}`,
      withCredentials: true,
    });

    loadingTask.promise
      .then((doc) => {
        if (cancelled) {
          void doc.destroy();
          return;
        }
        setPdfDoc(doc);
        setTotalPages(doc.numPages);
        setCurrentPage((prev) => Math.max(1, Math.min(prev, doc.numPages)));
      })
      .catch((err) => {
        if (!cancelled) {
          console.error("[CustomPdfReader] Load error:", err);
          setDocError("Impossible de charger ce document PDF.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingDoc(false);
      });

    return () => {
      cancelled = true;
      void loadingTask.destroy();
    };
  }, [documentId]);

  // Load extracted chunks for in-document search
  useEffect(() => {
    let active = true;
    fetch(`/api/documents/${documentId}`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (data: { document?: { chunks?: DocumentChunkPreview[] } } | null) => {
          if (active && data?.document?.chunks) {
            setChunks(data.document.chunks);
          }
        }
      )
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [documentId]);

  // Notify parent / Spix whenever currentPage or totalPages changes
  useEffect(() => {
    if (onPageChange) {
      onPageChange(currentPage, totalPages);
    }
  }, [currentPage, totalPages, onPageChange]);

  // Render active page onto high-DPI canvas & extract page text
  useEffect(() => {
    if (!pdfDoc) return;
    let cancelled = false;

    async function renderActivePage() {
      if (!pdfDoc) return;
      setRenderingPage(true);

      try {
        const page = await pdfDoc.getPage(currentPage);
        if (cancelled) return;

        // Extract selectable text for TEXT mode
        const textContent = await page.getTextContent();
        if (!cancelled) {
          const textLines = textContent.items
            .map((item) => ("str" in item ? item.str : ""))
            .filter(Boolean)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          setLivePageText(textLines);
        }

        if (viewMode !== "CANVAS" || !canvasRef.current) {
          return;
        }

        const baseViewport = page.getViewport({ scale: 1 });
        const targetScale =
          zoomMode === "FIT"
            ? Math.max(0.5, Math.min(2.2, containerWidth / baseViewport.width))
            : manualScale;

        const viewport = page.getViewport({ scale: targetScale });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) return;

        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
          renderTaskRef.current = null;
        }

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        context.setTransform(dpr, 0, 0, dpr, 0, 0);
        context.clearRect(0, 0, viewport.width, viewport.height);

        const task = page.render({
          canvasContext: context,
          viewport,
        });
        renderTaskRef.current = task;
        await task.promise;
      } catch (err) {
        if (
          err &&
          typeof err === "object" &&
          "name" in err &&
          err.name === "RenderingCancelledException"
        ) {
          return;
        }
        console.error("[CustomPdfReader] Render error:", err);
      } finally {
        if (!cancelled) {
          setRenderingPage(false);
        }
      }
    }

    void renderActivePage();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
    };
  }, [pdfDoc, currentPage, zoomMode, manualScale, containerWidth, viewMode]);

  const goToPage = useCallback(
    (target: number) => {
      const clamped = Math.max(1, Math.min(totalPages || 1, target));
      setCurrentPage(clamped);
      setPageInput(String(clamped));
    },
    [totalPages]
  );

  // Keyboard navigation
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT")
      ) {
        return;
      }
      if (e.key === "ArrowLeft") {
        goToPage(currentPage - 1);
      } else if (e.key === "ArrowRight") {
        goToPage(currentPage + 1);
      } else if (e.key === "Escape" && isFullscreen) {
        setIsFullscreen(false);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentPage, goToPage, isFullscreen]);

  const searchResults = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return [];
    const matches: Array<{ pageNumber: number; snippet: string }> = [];
    const seenPages = new Set<number>();

    for (const chunk of chunks) {
      const idx = chunk.content.toLowerCase().indexOf(q);
      if (idx !== -1 && !seenPages.has(chunk.pageNumber)) {
        seenPages.add(chunk.pageNumber);
        const start = Math.max(0, idx - 45);
        const end = Math.min(chunk.content.length, idx + q.length + 75);
        matches.push({
          pageNumber: chunk.pageNumber,
          snippet:
            (start > 0 ? "…" : "") +
            chunk.content.slice(start, end) +
            (end < chunk.content.length ? "…" : ""),
        });
      }
    }
    return matches;
  }, [chunks, searchQuery]);

  function handlePageInputSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = Number.parseInt(pageInput, 10);
    if (Number.isFinite(parsed)) {
      goToPage(parsed);
    } else {
      setPageInput(String(currentPage));
    }
  }

  return (
    <div
      className={
        isFullscreen
          ? "fixed inset-3 z-40 flex flex-col border border-ink bg-card"
          : "flex flex-col border border-ink bg-card"
      }
    >
      {/* Top Ink Header */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-ink px-4 py-2.5 text-card">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <FileText className="h-3.5 w-3.5 shrink-0" />
            <p className="truncate font-mono text-xs font-semibold uppercase tracking-wider">
              {title}
            </p>
          </div>
          <p className="mt-0.5 truncate font-mono text-[10px] uppercase tracking-wider text-card/75">
            {fileName} · LECTEUR PDF ARA · PAGE {currentPage} / {totalPages}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() => setSidebarOpen((p) => !p)}
            className={`inline-flex items-center gap-1 border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${
              sidebarOpen
                ? "border-card bg-card text-ink"
                : "border-card/30 text-card hover:bg-card/10"
            }`}
          >
            <List className="h-3 w-3" />
            <span>INDEX &amp; RECHERCHE</span>
          </button>

          <button
            type="button"
            onClick={() =>
              setViewMode((prev) => (prev === "CANVAS" ? "TEXT" : "CANVAS"))
            }
            className={`border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${
              viewMode === "TEXT"
                ? "border-card bg-card text-ink"
                : "border-card/30 text-card hover:bg-card/10"
            }`}
          >
            {viewMode === "CANVAS" ? "MODE TEXTE" : "MODE CANVAS"}
          </button>

          <a
            href={`/api/files/${documentId}`}
            download={fileName}
            title="Télécharger le PDF"
            className="inline-flex items-center gap-1 border border-card/30 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-card hover:bg-card/10"
          >
            <Download className="h-3 w-3" />
            <span className="hidden sm:inline">PDF</span>
          </a>

          <button
            type="button"
            onClick={() => setIsFullscreen((p) => !p)}
            title={isFullscreen ? "Quitter le plein écran" : "Plein écran"}
            className="border border-card/30 p-1 text-card hover:bg-card/10"
          >
            {isFullscreen ? (
              <Minimize2 className="h-3.5 w-3.5" />
            ) : (
              <Maximize2 className="h-3.5 w-3.5" />
            )}
          </button>

          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1 border border-card/30 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-card hover:bg-carmine"
          >
            <X className="h-3 w-3" />
            <span>FERMER</span>
          </button>
        </div>
      </div>

      {/* Control Toolbar (Pagination + Zoom) */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-paper px-4 py-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage <= 1}
            className="inline-flex items-center gap-1 border border-border bg-card px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-ink hover:border-ink disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            <span>PRÉC.</span>
          </button>

          <form
            onSubmit={handlePageInputSubmit}
            className="flex items-center gap-1.5 px-1"
          >
            <span className="font-mono text-[11px] uppercase tracking-wider text-stone">
              PAGE
            </span>
            <input
              type="text"
              inputMode="numeric"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onBlur={() => {
                const parsed = Number.parseInt(pageInput, 10);
                if (Number.isFinite(parsed)) goToPage(parsed);
                else setPageInput(String(currentPage));
              }}
              className="w-12 border border-border bg-card px-1.5 py-1 text-center font-mono text-xs font-bold text-ink focus:border-ink focus:outline-none"
            />
            <span className="font-mono text-[11px] uppercase tracking-wider text-stone">
              / {totalPages}
            </span>
          </form>

          <button
            type="button"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage >= totalPages}
            className="inline-flex items-center gap-1 border border-border bg-card px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-ink hover:border-ink disabled:opacity-40"
          >
            <span>SUIV.</span>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* Zoom Controls */}
        {viewMode === "CANVAS" && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setZoomMode("MANUAL");
                setManualScale((s) => Math.max(0.6, Number((s - 0.15).toFixed(2))));
              }}
              title="Zoom arrière"
              className="border border-border bg-card p-1.5 text-ink hover:border-ink"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>

            <span className="min-w-[54px] text-center font-mono text-[11px] uppercase tracking-wider text-ink">
              {zoomMode === "FIT"
                ? "AUTO"
                : `${Math.round(manualScale * 100)}%`}
            </span>

            <button
              type="button"
              onClick={() => {
                setZoomMode("MANUAL");
                setManualScale((s) => Math.min(2.2, Number((s + 0.15).toFixed(2))));
              }}
              title="Zoom avant"
              className="border border-border bg-card p-1.5 text-ink hover:border-ink"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>

            <button
              type="button"
              onClick={() => setZoomMode("FIT")}
              className={`border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${
                zoomMode === "FIT"
                  ? "border-ink bg-ink text-card"
                  : "border-border bg-card text-ink hover:border-ink"
              }`}
            >
              AJUSTER
            </button>
          </div>
        )}
      </div>

      {/* Main Reader Body */}
      <div
        className={`flex min-h-0 flex-1 ${
          isFullscreen ? "h-full" : "h-[620px]"
        }`}
      >
        {/* Optional Left Index & Search Sidebar */}
        {sidebarOpen && (
          <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-paper">
            <div className="border-b border-border p-2.5">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Rechercher dans le PDF..."
                  className="w-full border border-border bg-card py-1.5 pl-8 pr-2.5 text-xs text-ink placeholder:text-stone focus:border-ink focus:outline-none"
                />
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-2">
              {searchQuery.trim() ? (
                searchResults.length === 0 ? (
                  <p className="p-2 font-mono text-[10px] uppercase tracking-wider text-stone">
                    AUCUNE OCCURRENCE TROUVÉE.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    <p className="px-1 font-mono text-[10px] uppercase tracking-wider text-stone">
                      {searchResults.length} PAGE(S) TROUVÉE(S)
                    </p>
                    {searchResults.map((res) => (
                      <button
                        key={res.pageNumber}
                        type="button"
                        onClick={() => goToPage(res.pageNumber)}
                        className={`block w-full border p-2 text-left transition-colors ${
                          currentPage === res.pageNumber
                            ? "border-ink bg-pinned"
                            : "border-border bg-card hover:border-ink"
                        }`}
                      >
                        <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-badge-text">
                          PAGE {res.pageNumber}
                        </span>
                        <p className="mt-1 line-clamp-3 text-[11px] leading-snug text-ink">
                          {res.snippet}
                        </p>
                      </button>
                    ))}
                  </div>
                )
              ) : (
                <div className="grid grid-cols-3 gap-1.5">
                  {Array.from({ length: totalPages }, (_, idx) => idx + 1).map(
                    (pageNum) => (
                      <button
                        key={pageNum}
                        type="button"
                        onClick={() => goToPage(pageNum)}
                        className={`border py-2 font-mono text-xs transition-colors ${
                          currentPage === pageNum
                            ? "border-ink bg-ink font-bold text-card"
                            : "border-border bg-card text-ink hover:border-ink"
                        }`}
                      >
                        P.{pageNum}
                      </button>
                    )
                  )}
                </div>
              )}
            </div>
          </aside>
        )}

        {/* Viewport */}
        <div
          ref={viewportRef}
          className="relative flex-1 overflow-auto bg-[#ECEAE3] p-6"
        >
          {loadingDoc ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 font-mono text-xs uppercase tracking-wider text-stone">
              <Loader2 className="h-5 w-5 animate-spin text-ink" />
              <span>CHARGEMENT DU DOCUMENT PDF...</span>
            </div>
          ) : docError ? (
            <div className="mx-auto max-w-md border border-carmine/40 bg-card p-6 text-center font-mono text-xs text-carmine">
              {docError}
            </div>
          ) : viewMode === "TEXT" ? (
            <div className="mx-auto max-w-3xl border border-border bg-card p-6">
              <div className="mb-3 flex items-center justify-between border-b border-border pb-2 font-mono text-[11px] uppercase tracking-wider text-stone">
                <span>TRANSCRIPTION TEXTE · PAGE {currentPage}</span>
                <span>{livePageText.length} CARACTÈRES</span>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">
                {livePageText ||
                  "Aucun texte sélectionnable extrait sur cette page (page graphique ou numérisée)."}
              </p>
            </div>
          ) : (
            <div className="flex flex-col items-center">
              <div className="relative border border-border bg-white">
                <canvas ref={canvasRef} className="block" />
                {renderingPage && (
                  <div className="absolute right-2 top-2 border border-border bg-card/90 px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-stone">
                    RENDU...
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
