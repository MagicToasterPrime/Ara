"use client";

import { useEffect, useRef, useState } from "react";
import * as pdfjsLib from "pdfjs-dist";
import type { RenderTask } from "pdfjs-dist/types/src/display/api";
import { Crosshair, Loader2 } from "lucide-react";
import type { ImagePointAnswer } from "@/lib/revisions";

interface FallbackZone {
  id: string;
  label: string;
  xPercent: number;
  yPercent: number;
}

interface ImagePointCanvasProps {
  documentId: string;
  pageNumber: number;
  targetPhrase?: string;
  fallbackZones?: FallbackZone[];
  correctZoneId?: string;
  value?: ImagePointAnswer;
  disabled?: boolean;
  showCorrection?: boolean;
  onChange: (val: ImagePointAnswer) => void;
}

interface TargetBox {
  xPercent: number;
  yPercent: number;
  wPercent: number;
  hPercent: number;
}

function normalizeStr(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

export function ImagePointCanvas({
  documentId,
  pageNumber,
  targetPhrase,
  fallbackZones = [],
  correctZoneId,
  value,
  disabled = false,
  showCorrection = false,
  onChange,
}: ImagePointCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detectedTargetBox, setDetectedTargetBox] = useState<TargetBox | null>(
    null
  );

  useEffect(() => {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.js";
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setDetectedTargetBox(null);

    const loadingTask = pdfjsLib.getDocument({
      url: `/api/files/${documentId}`,
      withCredentials: true,
    });

    async function renderPage() {
      try {
        const doc = await loadingTask.promise;
        if (cancelled) {
          void doc.destroy();
          return;
        }

        const clampedPage = Math.max(1, Math.min(pageNumber, doc.numPages));
        const page = await doc.getPage(clampedPage);
        if (cancelled || !canvasRef.current) return;

        const containerWidth = Math.max(
          300,
          (containerRef.current?.clientWidth || 640) - 16
        );
        const baseViewport = page.getViewport({ scale: 1 });
        const scale = Math.min(1.6, containerWidth / baseViewport.width);
        const viewport = page.getViewport({ scale });

        // Locate real text coordinates of targetPhrase on this PDF page
        if (targetPhrase) {
          const textContent = await page.getTextContent();
          const normTarget = normalizeStr(targetPhrase);
          for (const item of textContent.items) {
            if (!("str" in item) || !item.str) continue;
            if (normalizeStr(item.str).includes(normTarget)) {
              const tx = pdfjsLib.Util.transform(
                viewport.transform,
                item.transform
              );
              const xPx = tx[4];
              const yPx = tx[5] - Math.abs(item.height || 12) * scale;
              const wPx = Math.max(40, (item.width || 60) * scale);
              const hPx = Math.max(18, Math.abs(item.height || 14) * scale * 1.4);

              if (!cancelled) {
                setDetectedTargetBox({
                  xPercent: Math.max(
                    0,
                    Math.min(100, (xPx / viewport.width) * 100)
                  ),
                  yPercent: Math.max(
                    0,
                    Math.min(100, (yPx / viewport.height) * 100)
                  ),
                  wPercent: Math.min(100, (wPx / viewport.width) * 100),
                  hPercent: Math.min(100, (hPx / viewport.height) * 100),
                });
              }
              break;
            }
          }
        }

        const canvas = canvasRef.current;
        const ctx = canvas.getContext("2d");
        if (!ctx || cancelled) return;

        if (renderTaskRef.current) {
          renderTaskRef.current.cancel();
          renderTaskRef.current = null;
        }

        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const task = page.render({ canvasContext: ctx, viewport });
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
        if (!cancelled) {
          setError("Impossible de charger la page image du cours.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void renderPage();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
        renderTaskRef.current = null;
      }
      void loadingTask.destroy();
    };
  }, [documentId, pageNumber, targetPhrase]);

  function handleCanvasClick(e: React.MouseEvent<HTMLDivElement>) {
    if (disabled || loading || error) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xPercent = Math.max(
      0,
      Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)
    );
    const yPercent = Math.max(
      0,
      Math.min(100, ((e.clientY - rect.top) / rect.height) * 100)
    );

    let matchedTarget = false;
    let selectedZoneId: string | undefined;

    if (detectedTargetBox) {
      const marginX = 11;
      const marginY = 9;
      const withinX =
        xPercent >= detectedTargetBox.xPercent - marginX &&
        xPercent <=
          detectedTargetBox.xPercent + detectedTargetBox.wPercent + marginX;
      const withinY =
        yPercent >= detectedTargetBox.yPercent - marginY &&
        yPercent <=
          detectedTargetBox.yPercent + detectedTargetBox.hPercent + marginY;
      matchedTarget = withinX && withinY;
    } else if (fallbackZones.length > 0) {
      let bestDist = Infinity;
      for (const z of fallbackZones) {
        const dist = Math.hypot(xPercent - z.xPercent, yPercent - z.yPercent);
        if (dist < bestDist) {
          bestDist = dist;
          selectedZoneId = z.id;
        }
      }
      matchedTarget = Boolean(
        selectedZoneId && correctZoneId && selectedZoneId === correctZoneId
      );
    }

    onChange({
      xPercent: Number(xPercent.toFixed(1)),
      yPercent: Number(yPercent.toFixed(1)),
      matchedTarget,
      selectedZoneId,
    });
  }

  const correctFallbackZone = !detectedTargetBox
    ? fallbackZones.find((z) => z.id === correctZoneId)
    : undefined;

  return (
    <div ref={containerRef} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-wider text-stone">
        <span className="inline-flex items-center gap-1.5">
          <Crosshair className="h-3.5 w-3.5 text-ink" />
          <span>CLIQUEZ DIRECTEMENT SUR L&apos;IMAGE POUR POINTER LA ZONE</span>
        </span>
        {value && (
          <span className="text-ink">
            POINTÉ : ({value.xPercent}% , {value.yPercent}%)
          </span>
        )}
      </div>

      <div className="relative flex justify-center overflow-auto border border-border bg-[#ECEAE3] p-2">
        {loading && (
          <div className="flex h-64 items-center justify-center gap-2 font-mono text-xs uppercase tracking-wider text-stone">
            <Loader2 className="h-4 w-4 animate-spin text-ink" />
            <span>RENDU DE LA PAGE {pageNumber}...</span>
          </div>
        )}

        {error && (
          <div className="p-6 font-mono text-xs text-carmine">{error}</div>
        )}

        <div
          onClick={handleCanvasClick}
          className={`relative inline-block border border-border bg-white ${
            loading || error
              ? "hidden"
              : disabled
              ? "cursor-default"
              : "cursor-crosshair"
          }`}
        >
          <canvas ref={canvasRef} className="block" />

          {/* Fallback clickable target markers if PDF has no text coordinates */}
          {!detectedTargetBox &&
            fallbackZones.map((zone) => {
              const isSelected = value?.selectedZoneId === zone.id;
              const isCorrect =
                showCorrection && correctZoneId === zone.id;
              return (
                <div
                  key={zone.id}
                  style={{
                    left: `${zone.xPercent}%`,
                    top: `${zone.yPercent}%`,
                    transform: "translate(-50%, -50%)",
                  }}
                  className={`pointer-events-none absolute flex h-8 w-8 items-center justify-center border font-mono text-xs font-bold ${
                    isCorrect
                      ? "border-forest bg-forest text-card"
                      : isSelected
                      ? "border-ink bg-ink text-card"
                      : "border-ink/70 bg-card/85 text-ink"
                  }`}
                >
                  {zone.label}
                </div>
              );
            })}

          {/* Correction bounding box when real text coordinates were found */}
          {showCorrection && detectedTargetBox && (
            <div
              style={{
                left: `${Math.max(0, detectedTargetBox.xPercent - 2)}%`,
                top: `${Math.max(0, detectedTargetBox.yPercent - 2)}%`,
                width: `${Math.min(100, detectedTargetBox.wPercent + 4)}%`,
                height: `${Math.min(100, detectedTargetBox.hPercent + 4)}%`,
              }}
              className="pointer-events-none absolute border-2 border-forest bg-forest/20"
            />
          )}

          {showCorrection && correctFallbackZone && (
            <div
              style={{
                left: `${correctFallbackZone.xPercent}%`,
                top: `${correctFallbackZone.yPercent}%`,
                transform: "translate(-50%, -50%)",
              }}
              className="pointer-events-none absolute h-12 w-12 border-2 border-forest bg-forest/20"
            />
          )}

          {/* User's clicked crosshair pin */}
          {value && (
            <div
              style={{
                left: `${value.xPercent}%`,
                top: `${value.yPercent}%`,
                transform: "translate(-50%, -50%)",
              }}
              className="pointer-events-none absolute flex items-center justify-center"
            >
              <div
                className={`flex h-6 w-6 items-center justify-center border-2 font-mono text-xs font-bold ${
                  showCorrection
                    ? value.matchedTarget
                      ? "border-forest bg-forest text-card"
                      : "border-carmine bg-carmine text-card"
                    : "border-ink bg-amber text-ink"
                }`}
              >
                ×
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
