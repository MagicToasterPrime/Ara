"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import * as pdfjsLib from "pdfjs-dist";
import type {
  PDFDocumentProxy,
  RenderTask,
} from "pdfjs-dist/types/src/display/api";
import {
  Bookmark,
  Check,
  ChevronLeft,
  ChevronRight,
  Crop,
  Download,
  FileText,
  Highlighter,
  ImagePlus,
  List,
  Loader2,
  Maximize2,
  Minimize2,
  PenTool,
  Save,
  Search,
  Sparkles,
  StickyNote,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useSpix } from "@/components/SpixContext";

interface DocumentChunkPreview {
  id: string;
  pageNumber: number;
  content: string;
}

export interface PdfHighlightRect {
  id: string;
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

export interface PdfPageAnnotation {
  pageNumber: number;
  isBookmarked: boolean;
  noteText: string;
  highlights: PdfHighlightRect[];
  updatedAt?: string;
}

interface CaptureBoxPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface CustomPdfReaderProps {
  documentId: string;
  ueId?: string;
  title: string;
  fileName: string;
  initialPage?: number;
  pageCountHint?: number;
  onPageChange?: (page: number, totalPages: number) => void;
  onCreateQuizFromCapture?: (imageDataUrl: string, pageNumber: number) => void;
  onClose: () => void;
}

export function CustomPdfReader({
  documentId,
  ueId,
  title,
  fileName,
  initialPage = 1,
  pageCountHint = 1,
  onPageChange,
  onCreateQuizFromCapture,
  onClose,
}: CustomPdfReaderProps) {
  const { triggerSpixImagePrompt, userAiAndSpixEnabled } = useSpix();

  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [totalPages, setTotalPages] = useState<number>(pageCountHint);
  const [currentPage, setCurrentPage] = useState<number>(
    Math.max(1, initialPage)
  );
  const [pageInput, setPageInput] = useState<string>(
    String(Math.max(1, initialPage))
  );

  const [zoomMode, setZoomMode] = useState<"FIT" | "MANUAL">("FIT");
  const [manualScale, setManualScale] = useState<number>(1.1);
  const [containerWidth, setContainerWidth] = useState<number>(760);

  const [loadingDoc, setLoadingDoc] = useState<boolean>(true);
  const [renderingPage, setRenderingPage] = useState<boolean>(false);
  const [docError, setDocError] = useState<string | null>(null);

  const [sidebarOpen, setSidebarOpen] = useState<boolean>(false);
  const [sidebarTab, setSidebarTab] = useState<"INDEX" | "NOTES">("INDEX");
  const [viewMode, setViewMode] = useState<"CANVAS" | "TEXT">("CANVAS");
  const [isFullscreen, setIsFullscreen] = useState<boolean>(false);

  const [chunks, setChunks] = useState<DocumentChunkPreview[]>([]);
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [livePageText, setLivePageText] = useState<string>("");

  // Annotations & Bookmarks
  const [annotationsByPage, setAnnotationsByPage] = useState<
    Record<number, PdfPageAnnotation>
  >({});
  const [noteDraft, setNoteDraft] = useState<string>("");
  const [savingNote, setSavingNote] = useState<boolean>(false);
  const [noteSavedFeedback, setNoteSavedFeedback] = useState<boolean>(false);

  // Zone Capture State
  const [captureMode, setCaptureMode] = useState<boolean>(false);
  const [isDraggingCapture, setIsDraggingCapture] = useState<boolean>(false);
  const captureStartRef = useRef<{ x: number; y: number } | null>(null);
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);
  const [captureRectPx, setCaptureRectPx] = useState<CaptureBoxPx | null>(null);
  const [capturedImageUrl, setCapturedImageUrl] = useState<string | null>(null);
  const [sendingToWb, setSendingToWb] = useState<boolean>(false);
  const [createdWbLink, setCreatedWbLink] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  // Sync external initialPage updates (e.g. clicking a Spix / Search citation badge)
  useEffect(() => {
    const safe = Math.max(
      1,
      Math.min(initialPage, totalPages || initialPage)
    );
    setCurrentPage(safe);
    setPageInput(String(safe));
  }, [initialPage, totalPages]);

  // Configure PDF.js worker once
  useEffect(() => {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
  }, []);

  // Observe canvas viewport width for FIT mode (tighter margins on mobile)
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;

    const updateWidth = () => {
      const padding = el.clientWidth < 640 ? 12 : 48;
      const next = Math.max(250, el.clientWidth - padding);
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

  // Load extracted chunks + personal annotations
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

    fetch(`/api/documents/${documentId}/annotations`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { annotations?: PdfPageAnnotation[] } | null) => {
        if (active && data?.annotations) {
          const map: Record<number, PdfPageAnnotation> = {};
          for (const a of data.annotations) {
            map[a.pageNumber] = a;
          }
          setAnnotationsByPage(map);
        }
      })
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [documentId]);

  // Keep draft note aligned with currentPage & clear pending capture when turning pages
  useEffect(() => {
    setNoteDraft(annotationsByPage[currentPage]?.noteText || "");
    setCaptureRectPx(null);
    setCapturedImageUrl(null);
    setNoteSavedFeedback(false);
  }, [currentPage, annotationsByPage]);

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
      } else if (e.key === "Escape") {
        if (captureRectPx) {
          setCaptureRectPx(null);
          setCapturedImageUrl(null);
        } else if (captureMode) {
          setCaptureMode(false);
        } else if (isFullscreen) {
          setIsFullscreen(false);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [currentPage, goToPage, isFullscreen, captureMode, captureRectPx]);

  const currentAnnotation: PdfPageAnnotation = annotationsByPage[currentPage] || {
    pageNumber: currentPage,
    isBookmarked: false,
    noteText: "",
    highlights: [],
  };

  const savedPagesList = useMemo(() => {
    return Object.values(annotationsByPage)
      .filter(
        (a) =>
          a.isBookmarked ||
          a.noteText.trim().length > 0 ||
          (a.highlights && a.highlights.length > 0)
      )
      .sort((a, b) => a.pageNumber - b.pageNumber);
  }, [annotationsByPage]);

  async function savePageAnnotation(next: PdfPageAnnotation) {
    setSavingNote(true);
    try {
      const res = await fetch(`/api/documents/${documentId}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (res.ok) {
        const data = (await res.json()) as {
          annotations?: PdfPageAnnotation[];
        };
        if (data.annotations) {
          const map: Record<number, PdfPageAnnotation> = {};
          for (const a of data.annotations) {
            map[a.pageNumber] = a;
          }
          setAnnotationsByPage(map);
        }
        setNoteSavedFeedback(true);
        setTimeout(() => setNoteSavedFeedback(false), 1800);
      }
    } finally {
      setSavingNote(false);
    }
  }

  async function handleToggleBookmark() {
    await savePageAnnotation({
      ...currentAnnotation,
      pageNumber: currentPage,
      isBookmarked: !currentAnnotation.isBookmarked,
    });
  }

  async function handleSaveNoteText() {
    await savePageAnnotation({
      ...currentAnnotation,
      pageNumber: currentPage,
      noteText: noteDraft,
    });
  }

  async function handleRemoveHighlight(highlightId: string) {
    await savePageAnnotation({
      ...currentAnnotation,
      pageNumber: currentPage,
      highlights: (currentAnnotation.highlights || []).filter(
        (h) => h.id !== highlightId
      ),
    });
  }

  // Rectangular zone capture handlers
  function getOverlayRelativePos(e: React.PointerEvent<HTMLDivElement>) {
    const rect = overlayRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0, width: 1, height: 1 };
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const y = Math.max(0, Math.min(rect.height, e.clientY - rect.top));
    return { x, y, width: rect.width, height: rect.height };
  }

  function handleCapturePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!captureMode || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const pos = getOverlayRelativePos(e);
    captureStartRef.current = { x: pos.x, y: pos.y };
    setCapturedImageUrl(null);
    setCreatedWbLink(null);
    setCaptureRectPx({ x: pos.x, y: pos.y, w: 0, h: 0 });
    setIsDraggingCapture(true);
  }

  function handleCapturePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!isDraggingCapture || !captureStartRef.current) return;
    const pos = getOverlayRelativePos(e);
    const sx = captureStartRef.current.x;
    const sy = captureStartRef.current.y;
    setCaptureRectPx({
      x: Math.min(sx, pos.x),
      y: Math.min(sy, pos.y),
      w: Math.abs(pos.x - sx),
      h: Math.abs(pos.y - sy),
    });
  }

  function handleCapturePointerUp(e: React.PointerEvent<HTMLDivElement>) {
    if (!isDraggingCapture) return;
    setIsDraggingCapture(false);
    captureStartRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // Ignore
    }

    if (
      !captureRectPx ||
      captureRectPx.w < 16 ||
      captureRectPx.h < 16 ||
      !canvasRef.current ||
      !overlayRef.current
    ) {
      setCaptureRectPx(null);
      return;
    }

    const canvas = canvasRef.current;
    const displayRect = overlayRef.current.getBoundingClientRect();
    const scaleX = canvas.width / Math.max(1, displayRect.width);
    const scaleY = canvas.height / Math.max(1, displayRect.height);

    const sx = Math.floor(captureRectPx.x * scaleX);
    const sy = Math.floor(captureRectPx.y * scaleY);
    const sw = Math.max(10, Math.floor(captureRectPx.w * scaleX));
    const sh = Math.max(10, Math.floor(captureRectPx.h * scaleY));

    const offscreen = document.createElement("canvas");
    offscreen.width = sw;
    offscreen.height = sh;
    const ctx = offscreen.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, sw, sh);
      ctx.drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
      setCapturedImageUrl(offscreen.toDataURL("image/png"));
    }
  }

  async function handleSendCaptureToWhiteboard() {
    if (!capturedImageUrl || sendingToWb) return;
    setSendingToWb(true);
    try {
      const boardTitle = `${title.slice(0, 28)} · Fig. P.${currentPage}`;
      const createRes = await fetch("/api/whiteboards", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: boardTitle,
          ueId: ueId || null,
          isPublic: false,
        }),
      });
      if (!createRes.ok) return;
      const createData = (await createRes.json()) as {
        whiteboard?: { id: string; title: string };
      };
      if (!createData.whiteboard) return;

      const dims = await new Promise<{ w: number; h: number }>((resolve) => {
        const img = new Image();
        img.onload = () => {
          const maxW = 540;
          const scale = img.width > maxW ? maxW / img.width : 1;
          resolve({
            w: Math.round(img.width * scale),
            h: Math.round(img.height * scale),
          });
        };
        img.onerror = () => resolve({ w: 420, h: 300 });
        img.src = capturedImageUrl;
      });

      const snapshot = {
        version: 2,
        background: "DOTS",
        elements: [
          {
            id: `el-pdf-${Date.now()}`,
            type: "image",
            x: 120,
            y: 80,
            width: dims.w,
            height: dims.h,
            dataUrl: capturedImageUrl,
            caption: `${fileName} · PAGE ${currentPage}`,
            strokeColor: "#1A1A1A",
            fillColor: "#FCFBF9",
            strokeWidth: 1.5,
            dash: "solid",
            opacity: 1,
          },
        ],
      };

      await fetch(`/api/whiteboards/${createData.whiteboard.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ snapshotData: JSON.stringify(snapshot) }),
      });

      setCreatedWbLink({
        id: createData.whiteboard.id,
        title: createData.whiteboard.title,
      });
    } finally {
      setSendingToWb(false);
    }
  }

  async function handleSaveZoneAsHighlight() {
    if (!captureRectPx || !overlayRef.current) return;
    const rect = overlayRef.current.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const newHighlight: PdfHighlightRect = {
      id: `hl-${Date.now()}`,
      xPct: Number(((captureRectPx.x / rect.width) * 100).toFixed(2)),
      yPct: Number(((captureRectPx.y / rect.height) * 100).toFixed(2)),
      wPct: Number(((captureRectPx.w / rect.width) * 100).toFixed(2)),
      hPct: Number(((captureRectPx.h / rect.height) * 100).toFixed(2)),
    };

    await savePageAnnotation({
      ...currentAnnotation,
      pageNumber: currentPage,
      highlights: [...(currentAnnotation.highlights || []), newHighlight],
    });

    setCaptureRectPx(null);
    setCapturedImageUrl(null);
  }

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
            onClick={() => {
              setSidebarOpen((p) => (sidebarTab === "INDEX" ? !p : true));
              setSidebarTab("INDEX");
            }}
            className={`inline-flex items-center gap-1 border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${
              sidebarOpen && sidebarTab === "INDEX"
                ? "border-card bg-card text-ink"
                : "border-card/30 text-card hover:bg-card/10"
            }`}
          >
            <List className="h-3 w-3" />
            <span>INDEX &amp; RECHERCHE</span>
          </button>

          <button
            type="button"
            onClick={() => {
              setSidebarOpen((p) => (sidebarTab === "NOTES" ? !p : true));
              setSidebarTab("NOTES");
            }}
            className={`inline-flex items-center gap-1 border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider ${
              sidebarOpen && sidebarTab === "NOTES"
                ? "border-card bg-card text-ink"
                : "border-card/30 text-card hover:bg-card/10"
            }`}
          >
            <StickyNote className="h-3 w-3" />
            <span>NOTES ({savedPagesList.length})</span>
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

      {/* Control Toolbar (Pagination + Capture/Bookmark + Zoom) */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-paper px-4 py-2">
        <div className="flex flex-wrap items-center gap-1.5">
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

          <div className="mx-1 hidden h-4 w-px bg-border sm:block" />

          {/* Capture Zone Tool */}
          {viewMode === "CANVAS" && (
            <button
              type="button"
              onClick={() => {
                setCaptureMode((p) => !p);
                setCaptureRectPx(null);
                setCapturedImageUrl(null);
              }}
              className={`inline-flex items-center gap-1 border px-2.5 py-1 font-mono text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                captureMode
                  ? "border-amber bg-amber text-card"
                  : "border-border bg-card text-ink hover:border-ink"
              }`}
              title="Sélectionner un schéma ou une figure sur la page"
            >
              <Crop className="h-3 w-3" />
              <span>{captureMode ? "MODE CAPTURE ACTIF" : "CAPTURER ZONE"}</span>
            </button>
          )}

          {/* Page Bookmark Toggle */}
          <button
            type="button"
            disabled={savingNote}
            onClick={handleToggleBookmark}
            className={`inline-flex items-center gap-1 border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
              currentAnnotation.isBookmarked
                ? "border-ink bg-ink text-card"
                : "border-border bg-card text-ink hover:border-ink"
            }`}
            title="Épingler cette page dans vos favoris"
          >
            <Bookmark className="h-3 w-3" />
            <span>
              {currentAnnotation.isBookmarked ? "PAGE ÉPINGLÉE" : "ÉPINGLER"}
            </span>
          </button>
        </div>

        {/* Zoom Controls */}
        {viewMode === "CANVAS" && (
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setZoomMode("MANUAL");
                setManualScale((s) =>
                  Math.max(0.6, Number((s - 0.15).toFixed(2)))
                );
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
                setManualScale((s) =>
                  Math.min(2.2, Number((s + 0.15).toFixed(2)))
                );
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

      {/* Created Whiteboard Confirmation Strip */}
      {createdWbLink && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-badge-bg px-4 py-2 text-badge-text">
          <span className="font-mono text-[11px] uppercase tracking-wider">
            CAPTURE IMPORTÉE DANS LE TABLEAU BLANC « {createdWbLink.title} »
          </span>
          <div className="flex items-center gap-2">
            <Link
              href={`/whiteboard/${createdWbLink.id}`}
              className="border border-badge-text bg-card px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-badge-text hover:bg-badge-text hover:text-card"
            >
              OUVRIR LE TABLEAU →
            </Link>
            <button
              type="button"
              onClick={() => setCreatedWbLink(null)}
              className="p-0.5 hover:text-ink"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Active Capture Action Strip */}
      {capturedImageUrl && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ink bg-pinned px-4 py-2.5">
          <div className="flex items-center gap-3">
            <img
              src={capturedImageUrl}
              alt="Zone capturée"
              className="h-12 w-16 border border-ink bg-white object-contain"
            />
            <div>
              <p className="font-mono text-[11px] font-bold uppercase tracking-wider text-ink">
                ZONE CAPTURÉE · PAGE {currentPage}
              </p>
              <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                CHOISISSEZ UNE ACTION CI-CONTRE
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            {userAiAndSpixEnabled && (
              <button
                type="button"
                onClick={() => {
                  triggerSpixImagePrompt({
                    imageDataUrl: capturedImageUrl,
                    prompt: `Explique en détail cette figure / cet extrait issu de « ${title} » (page ${currentPage}).`,
                    pageNumber: currentPage,
                  });
                  setCaptureRectPx(null);
                  setCapturedImageUrl(null);
                  setCaptureMode(false);
                }}
                className="inline-flex items-center gap-1 border border-ink bg-ink px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-card hover:bg-ink/90"
              >
                <Sparkles className="h-3 w-3" />
                <span>EXPLIQUER AVEC SPIX</span>
              </button>
            )}

            {onCreateQuizFromCapture && (
              <button
                type="button"
                onClick={() => {
                  onCreateQuizFromCapture(capturedImageUrl, currentPage);
                  setCaptureRectPx(null);
                  setCapturedImageUrl(null);
                  setCaptureMode(false);
                }}
                className="inline-flex items-center gap-1 border border-badge-text bg-badge-bg px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-badge-text hover:bg-badge-text hover:text-card"
              >
                <ImagePlus className="h-3 w-3" />
                <span>QUIZ À LÉGENDER</span>
              </button>
            )}

            <button
              type="button"
              disabled={sendingToWb}
              onClick={handleSendCaptureToWhiteboard}
              className="inline-flex items-center gap-1 border border-ink bg-card px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:bg-paper disabled:opacity-50"
            >
              <PenTool className="h-3 w-3" />
              <span>
                {sendingToWb ? "ENVOI..." : "VERS TABLEAU BLANC"}
              </span>
            </button>

            <button
              type="button"
              onClick={handleSaveZoneAsHighlight}
              className="inline-flex items-center gap-1 border border-amber bg-amber/15 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:bg-amber/30"
            >
              <Highlighter className="h-3 w-3" />
              <span>SURLIGNER P.{currentPage}</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setCaptureRectPx(null);
                setCapturedImageUrl(null);
              }}
              className="border border-border bg-card p-1.5 text-stone hover:text-ink"
              title="Annuler la capture"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Main Reader Body */}
      <div
        className={`flex min-h-0 flex-1 ${
          isFullscreen ? "h-full" : "h-[640px]"
        }`}
      >
        {/* Optional Left Sidebar (Index / Search OR Personal Notes & Bookmarks) */}
        {sidebarOpen && (
          <aside className="flex w-72 shrink-0 flex-col border-r border-border bg-paper">
            <div className="grid grid-cols-2 border-b border-border bg-card font-mono text-[10px] uppercase tracking-wider">
              <button
                type="button"
                onClick={() => setSidebarTab("INDEX")}
                className={`border-r border-border py-2 ${
                  sidebarTab === "INDEX"
                    ? "bg-ink font-bold text-card"
                    : "text-stone hover:text-ink"
                }`}
              >
                INDEX / CHERCHER
              </button>
              <button
                type="button"
                onClick={() => setSidebarTab("NOTES")}
                className={`py-2 ${
                  sidebarTab === "NOTES"
                    ? "bg-ink font-bold text-card"
                    : "text-stone hover:text-ink"
                }`}
              >
                NOTES ({savedPagesList.length})
              </button>
            </div>

            {sidebarTab === "INDEX" ? (
              <>
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
                      {Array.from(
                        { length: totalPages },
                        (_, idx) => idx + 1
                      ).map((pageNum) => {
                        const meta = annotationsByPage[pageNum];
                        return (
                          <button
                            key={pageNum}
                            type="button"
                            onClick={() => goToPage(pageNum)}
                            className={`relative border py-2 font-mono text-xs transition-colors ${
                              currentPage === pageNum
                                ? "border-ink bg-ink font-bold text-card"
                                : "border-border bg-card text-ink hover:border-ink"
                            }`}
                          >
                            P.{pageNum}
                            {meta?.isBookmarked && (
                              <span
                                className="absolute right-1 top-1 h-1.5 w-1.5 bg-amber"
                                title="Page épinglée"
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col overflow-hidden">
                {/* Active Page Note Editor */}
                <div className="border-b border-border bg-card p-3">
                  <div className="mb-1.5 flex items-center justify-between font-mono text-[10px] uppercase tracking-wider">
                    <span className="font-bold text-ink">
                      NOTE SUR LA PAGE {currentPage}
                    </span>
                    {noteSavedFeedback && (
                      <span className="inline-flex items-center gap-1 text-forest">
                        <Check className="h-3 w-3" />
                        SAUVÉE
                      </span>
                    )}
                  </div>
                  <textarea
                    rows={5}
                    value={noteDraft}
                    onChange={(e) => setNoteDraft(e.target.value)}
                    placeholder={`Écrivez vos remarques personnelles pour la page ${currentPage}...`}
                    className="w-full border border-border bg-paper p-2 text-xs text-ink placeholder:text-stone focus:border-ink focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={savingNote}
                    onClick={handleSaveNoteText}
                    className="mt-2 inline-flex w-full items-center justify-center gap-1.5 border border-ink bg-ink px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-card hover:bg-ink/90 disabled:opacity-50"
                  >
                    <Save className="h-3 w-3" />
                    <span>
                      {savingNote ? "ENREGISTREMENT..." : "ENREGISTRER LA NOTE"}
                    </span>
                  </button>
                </div>

                {/* Annotated / Bookmarked Pages List */}
                <div className="flex-1 overflow-y-auto p-2.5">
                  <p className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-wider text-stone">
                    PAGES ÉPINGLÉES &amp; ANNOTÉES
                  </p>
                  {savedPagesList.length === 0 ? (
                    <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                      AUCUNE PAGE ANNOTÉE POUR L&apos;INSTANT.
                    </p>
                  ) : (
                    <div className="space-y-1.5">
                      {savedPagesList.map((item) => (
                        <button
                          key={item.pageNumber}
                          type="button"
                          onClick={() => goToPage(item.pageNumber)}
                          className={`block w-full border p-2 text-left ${
                            currentPage === item.pageNumber
                              ? "border-ink bg-pinned"
                              : "border-border bg-card hover:border-ink"
                          }`}
                        >
                          <div className="flex items-center justify-between gap-1 font-mono text-[10px] uppercase tracking-wider">
                            <span className="font-bold text-ink">
                              PAGE {item.pageNumber}
                            </span>
                            <div className="flex items-center gap-1">
                              {item.isBookmarked && (
                                <span className="bg-amber px-1 text-[9px] font-bold text-card">
                                  ÉPINGLÉE
                                </span>
                              )}
                              {item.highlights.length > 0 && (
                                <span className="border border-border bg-paper px-1 text-[9px] text-stone">
                                  {item.highlights.length} SURL.
                                </span>
                              )}
                            </div>
                          </div>
                          {item.noteText.trim() && (
                            <p className="mt-1 line-clamp-2 text-[11px] text-stone">
                              {item.noteText}
                            </p>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            )}
          </aside>
        )}

        {/* Viewport */}
        <div
          ref={viewportRef}
          onTouchStart={(e) => {
            if (zoomMode !== "FIT" || captureMode || viewMode !== "CANVAS") {
              swipeStartRef.current = null;
              return;
            }
            const t = e.changedTouches[0];
            if (t) {
              swipeStartRef.current = { x: t.clientX, y: t.clientY };
            }
          }}
          onTouchEnd={(e) => {
            const start = swipeStartRef.current;
            swipeStartRef.current = null;
            if (!start || zoomMode !== "FIT" || captureMode || viewMode !== "CANVAS") {
              return;
            }
            const t = e.changedTouches[0];
            if (!t) return;
            const dx = t.clientX - start.x;
            const dy = t.clientY - start.y;
            if (Math.abs(dx) > 65 && Math.abs(dx) > Math.abs(dy) * 1.4) {
              if (dx < 0 && currentPage < totalPages) {
                goToPage(currentPage + 1);
              } else if (dx > 0 && currentPage > 1) {
                goToPage(currentPage - 1);
              }
            }
          }}
          className="relative flex-1 overflow-auto bg-[#ECEAE3] p-2 sm:p-6"
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

                {/* Interactive Highlights + Zone Capture Layer */}
                <div
                  ref={overlayRef}
                  onPointerDown={handleCapturePointerDown}
                  onPointerMove={handleCapturePointerMove}
                  onPointerUp={handleCapturePointerUp}
                  className={`absolute inset-0 ${
                    captureMode
                      ? "cursor-crosshair"
                      : "pointer-events-none"
                  }`}
                >
                  {/* Saved User Highlights on this Page */}
                  {(currentAnnotation.highlights || []).map((hl) => (
                    <div
                      key={hl.id}
                      className="group pointer-events-auto absolute border border-amber bg-amber/20"
                      style={{
                        left: `${hl.xPct}%`,
                        top: `${hl.yPct}%`,
                        width: `${hl.wPct}%`,
                        height: `${hl.hPct}%`,
                      }}
                    >
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          void handleRemoveHighlight(hl.id);
                        }}
                        title="Supprimer ce surlignage"
                        className="absolute -right-2 -top-2 hidden h-4 w-4 items-center justify-center bg-carmine text-[10px] text-card group-hover:flex"
                      >
                        ×
                      </button>
                    </div>
                  ))}

                  {/* Active Rectangular Capture Selection */}
                  {captureRectPx && (
                    <div
                      className="absolute border-2 border-ink bg-amber/15"
                      style={{
                        left: captureRectPx.x,
                        top: captureRectPx.y,
                        width: captureRectPx.w,
                        height: captureRectPx.h,
                      }}
                    />
                  )}
                </div>

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
