"use client";

import { useEffect, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  FileText,
  ImagePlus,
  Loader2,
  MousePointerClick,
  Trash2,
} from "lucide-react";
import { renderPdfPageToDataUrl } from "@/lib/pdf-client";
import type { OcclusionMask } from "@/lib/quiz-types";

export interface PdfPickerDoc {
  id: string;
  title: string;
  fileName: string;
  pageCount: number;
}

interface ImageOcclusionEditorProps {
  documents: PdfPickerDoc[];
  imageDataUrl: string;
  masks: OcclusionMask[];
  sourceDocId?: string;
  sourcePageNumber?: number;
  onChange: (next: {
    imageDataUrl: string;
    masks: OcclusionMask[];
    sourceDocId?: string;
    sourcePageNumber?: number;
  }) => void;
}

function resizeImageFileToDataUrl(
  file: File,
  maxWidth = 1100
): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxWidth / img.width);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(img.width * scale));
        canvas.height = Math.max(1, Math.round(img.height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) {
          resolve(String(reader.result || ""));
          return;
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      };
      img.onerror = () => reject(new Error("Image invalide"));
      img.src = String(reader.result || "");
    };
    reader.onerror = () => reject(new Error("Lecture image impossible"));
    reader.readAsDataURL(file);
  });
}

export function ImageOcclusionEditor({
  documents,
  imageDataUrl,
  masks,
  sourceDocId,
  sourcePageNumber,
  onChange,
}: ImageOcclusionEditorProps) {
  const [selectedDocId, setSelectedDocId] = useState<string>(
    sourceDocId || documents[0]?.id || ""
  );
  const [pdfPage, setPdfPage] = useState<number>(sourcePageNumber || 1);
  const [capturingPdf, setCapturingPdf] = useState(false);
  const [previewMasksOpaque, setPreviewMasksOpaque] = useState(true);

  // Drag rectangle drawing state
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [dragStart, setDragStart] = useState<{ x: number; y: number } | null>(
    null
  );
  const [dragCurrent, setDragCurrent] = useState<{
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    if (!selectedDocId && documents.length > 0) {
      setSelectedDocId(documents[0].id);
    }
  }, [documents, selectedDocId]);

  const activePdfDoc = documents.find((d) => d.id === selectedDocId);

  async function handleCapturePdfPage() {
    if (!selectedDocId || capturingPdf) return;
    setCapturingPdf(true);
    try {
      const dataUrl = await renderPdfPageToDataUrl(selectedDocId, pdfPage, 1050);
      if (dataUrl) {
        onChange({
          imageDataUrl: dataUrl,
          masks: [],
          sourceDocId: selectedDocId,
          sourcePageNumber: pdfPage,
        });
      }
    } finally {
      setCapturingPdf(false);
    }
  }

  async function handleUploadImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const dataUrl = await resizeImageFileToDataUrl(file);
      onChange({
        imageDataUrl: dataUrl,
        masks: [],
        sourceDocId: undefined,
        sourcePageNumber: undefined,
      });
    } catch {
      // Ignore invalid image
    }
  }

  function getRelativeCoords(e: React.PointerEvent<HTMLDivElement>) {
    const rect = stageRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) {
      return { x: 0, y: 0 };
    }
    const x = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
    const y = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
    return { x, y };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!imageDataUrl) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const pt = getRelativeCoords(e);
    setDragStart(pt);
    setDragCurrent(pt);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!dragStart) return;
    setDragCurrent(getRelativeCoords(e));
  }

  function handlePointerUp() {
    if (!dragStart || !dragCurrent) {
      setDragStart(null);
      setDragCurrent(null);
      return;
    }

    const x = Math.min(dragStart.x, dragCurrent.x);
    const y = Math.min(dragStart.y, dragCurrent.y);
    const w = Math.abs(dragCurrent.x - dragStart.x);
    const h = Math.abs(dragCurrent.y - dragStart.y);

    setDragStart(null);
    setDragCurrent(null);

    // Ignore accidental micro-clicks (< 2% width or height)
    if (w < 2 || h < 1.5) return;

    const nextIndex = masks.length + 1;
    const newMask: OcclusionMask = {
      id: `mask-${Date.now()}-${nextIndex}`,
      index: nextIndex,
      xPercent: Number(x.toFixed(2)),
      yPercent: Number(y.toFixed(2)),
      wPercent: Number(w.toFixed(2)),
      hPercent: Number(h.toFixed(2)),
      label: "",
    };

    onChange({
      imageDataUrl,
      masks: [...masks, newMask],
      sourceDocId,
      sourcePageNumber,
    });
  }

  function updateMaskLabel(id: string, label: string) {
    onChange({
      imageDataUrl,
      masks: masks.map((m) => (m.id === id ? { ...m, label } : m)),
      sourceDocId,
      sourcePageNumber,
    });
  }

  function removeMask(id: string) {
    const filtered = masks
      .filter((m) => m.id !== id)
      .map((m, idx) => ({ ...m, index: idx + 1 }));
    onChange({
      imageDataUrl,
      masks: filtered,
      sourceDocId,
      sourcePageNumber,
    });
  }

  const draftRect =
    dragStart && dragCurrent
      ? {
          x: Math.min(dragStart.x, dragCurrent.x),
          y: Math.min(dragStart.y, dragCurrent.y),
          w: Math.abs(dragCurrent.x - dragStart.x),
          h: Math.abs(dragCurrent.y - dragStart.y),
        }
      : null;

  return (
    <div className="space-y-4 border border-border bg-paper p-4">
      {/* Step A: Pick Image Source */}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {/* Source 1: PDF Page Extractor */}
        <div className="border border-border bg-card p-3">
          <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-ink">
            <FileText className="h-3.5 w-3.5" />
            <span>1A. CAPTURER UNE PAGE DE PDF</span>
          </p>
          {documents.length === 0 ? (
            <p className="font-mono text-[10px] text-stone">
              Aucun PDF disponible. Importez une image à droite.
            </p>
          ) : (
            <div className="space-y-2">
              <select
                value={selectedDocId}
                onChange={(e) => {
                  setSelectedDocId(e.target.value);
                  setPdfPage(1);
                }}
                className="w-full border border-border bg-paper px-2.5 py-1.5 text-xs text-ink focus:border-ink focus:outline-none"
              >
                {documents.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.title} ({d.pageCount} p.)
                  </option>
                ))}
              </select>

              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setPdfPage((p) => Math.max(1, p - 1))}
                    disabled={pdfPage <= 1}
                    className="border border-border bg-paper p-1 text-ink disabled:opacity-40"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </button>
                  <span className="px-2 font-mono text-[11px] uppercase text-ink">
                    P. {pdfPage} / {activePdfDoc?.pageCount || 1}
                  </span>
                  <button
                    type="button"
                    onClick={() =>
                      setPdfPage((p) =>
                        Math.min(activePdfDoc?.pageCount || 1, p + 1)
                      )
                    }
                    disabled={pdfPage >= (activePdfDoc?.pageCount || 1)}
                    className="border border-border bg-paper p-1 text-ink disabled:opacity-40"
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </button>
                </div>

                <button
                  type="button"
                  disabled={capturingPdf}
                  onClick={handleCapturePdfPage}
                  className="inline-flex items-center gap-1 border border-ink bg-ink px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-card hover:bg-ink/90 disabled:opacity-50"
                >
                  {capturingPdf && (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  )}
                  <span>CAPTURER CETTE PAGE</span>
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Source 2: Local Image File */}
        <div className="border border-border bg-card p-3">
          <p className="mb-2 flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-ink">
            <ImagePlus className="h-3.5 w-3.5" />
            <span>1B. OU IMPORTER UN SCHÉMA (PNG / JPG)</span>
          </p>
          <input
            type="file"
            accept="image/*"
            onChange={handleUploadImage}
            className="w-full border border-border bg-paper px-2 py-1.5 font-mono text-xs text-ink"
          />
          <p className="mt-1.5 font-mono text-[10px] text-stone">
            L&apos;image est automatiquement compressée pour le partage promo.
          </p>
        </div>
      </div>

      {/* Step B: Draw Occlusion Rectangles over Legends */}
      {imageDataUrl && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2 border border-border bg-card px-3 py-2">
            <span className="inline-flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-ink">
              <MousePointerClick className="h-3.5 w-3.5 text-amber" />
              <span>
                2. CLIQUEZ-GLISSEZ SUR LES LÉGENDES POUR LES CACHER ({masks.length} CACHE
                {masks.length > 1 ? "S" : ""})
              </span>
            </span>

            <button
              type="button"
              onClick={() => setPreviewMasksOpaque((p) => !p)}
              className="inline-flex items-center gap-1 border border-border bg-paper px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink"
            >
              {previewMasksOpaque ? (
                <>
                  <Eye className="h-3 w-3" />
                  <span>VOIR SOUS LES CACHES</span>
                </>
              ) : (
                <>
                  <EyeOff className="h-3 w-3" />
                  <span>RENDRE LES CACHES OPAQUES</span>
                </>
              )}
            </button>
          </div>

          <div className="flex justify-center overflow-auto border border-border bg-[#ECEAE3] p-3">
            <div
              ref={stageRef}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              className="relative inline-block max-w-full cursor-crosshair select-none border border-ink bg-white"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={imageDataUrl}
                alt="Planche à légender"
                draggable={false}
                className="block max-h-[540px] w-auto max-w-full"
              />

              {/* Existing Masks */}
              {masks.map((mask) => (
                <div
                  key={mask.id}
                  style={{
                    left: `${mask.xPercent}%`,
                    top: `${mask.yPercent}%`,
                    width: `${mask.wPercent}%`,
                    height: `${mask.hPercent}%`,
                  }}
                  className={`pointer-events-none absolute flex items-center justify-center border-2 border-amber font-mono text-xs font-bold ${
                    previewMasksOpaque
                      ? "bg-ink text-card"
                      : "bg-ink/25 text-ink"
                  }`}
                >
                  #{mask.index}
                </div>
              ))}

              {/* Active Drag Preview */}
              {draftRect && (
                <div
                  style={{
                    left: `${draftRect.x}%`,
                    top: `${draftRect.y}%`,
                    width: `${draftRect.w}%`,
                    height: `${draftRect.h}%`,
                  }}
                  className="pointer-events-none absolute border-2 border-dashed border-carmine bg-amber/30"
                />
              )}
            </div>
          </div>

          {/* Step C: Enter Expected Legends for each Mask */}
          {masks.length > 0 && (
            <div className="border border-border bg-card p-3">
              <p className="mb-2 font-mono text-[10px] font-bold uppercase tracking-wider text-stone">
                3. RENSEIGNEZ LA LÉGENDE ATTENDUE POUR CHAQUE CACHE :
              </p>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {masks.map((mask) => (
                  <div
                    key={mask.id}
                    className="flex items-center gap-2 border border-border bg-paper p-2"
                  >
                    <span className="flex h-6 w-8 shrink-0 items-center justify-center border border-ink bg-ink font-mono text-xs font-bold text-card">
                      #{mask.index}
                    </span>
                    <input
                      type="text"
                      value={mask.label}
                      onChange={(e) => updateMaskLabel(mask.id, e.target.value)}
                      placeholder={`Légende exacte pour #${mask.index}...`}
                      className="min-w-0 flex-1 border border-border bg-card px-2.5 py-1 text-xs text-ink focus:border-ink focus:outline-none"
                    />
                    <button
                      type="button"
                      onClick={() => removeMask(mask.id)}
                      title="Supprimer ce cache"
                      className="text-stone hover:text-carmine"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
