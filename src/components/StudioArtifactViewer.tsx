"use client";

import { useState } from "react";
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  Download,
  FileText,
  Maximize2,
  Minimize2,
  RotateCw,
} from "lucide-react";
import type { RevisionQuestion } from "@/lib/revisions";
import type {
  StudioArtifactContent,
  StudioSourceRef,
} from "@/lib/studio";

function normalizeTextForMatch(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ");
}

interface StudioArtifactViewerProps {
  title: string;
  content: StudioArtifactContent;
  compact?: boolean;
  onOpenSource?: (source: StudioSourceRef) => void;
}

export function StudioArtifactViewer({
  title,
  content,
  compact = false,
  onOpenSource,
}: StudioArtifactViewerProps) {
  // SVG state
  const [svgFullscreen, setSvgFullscreen] = useState(false);
  const [copiedSvg, setCopiedSvg] = useState(false);

  // Flashcards state
  const [cardIndex, setCardIndex] = useState(0);
  const [flipped, setFlipped] = useState(false);
  const [masteredIds, setMasteredIds] = useState<Record<string, boolean>>({});

  // Quiz state
  const [quizAnswers, setQuizAnswers] = useState<
    Record<string, number[] | string>
  >({});
  const [quizSubmitted, setQuizSubmitted] = useState(false);

  function handleDownloadSvg(svgMarkup: string) {
    const blob = new Blob([svgMarkup], {
      type: "image/svg+xml;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "schema-ara";
    a.href = url;
    a.download = `${slug}.svg`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function handleCopySvg(svgMarkup: string) {
    try {
      await navigator.clipboard.writeText(svgMarkup);
      setCopiedSvg(true);
      setTimeout(() => setCopiedSvg(false), 2000);
    } catch {
      // Clipboard unavailable
    }
  }

  if (content.kind === "SVG_DIAGRAM") {
    return (
      <div
        className={
          svgFullscreen
            ? "fixed inset-4 z-50 flex flex-col border border-ink bg-card"
            : "border border-ink bg-card"
        }
      >
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-paper px-3 py-2">
          <span className="truncate font-mono text-[11px] font-bold uppercase tracking-wider text-ink">
            SCHÉMA VECTORIEL .SVG · {title}
          </span>
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => handleDownloadSvg(content.svg)}
              className="inline-flex items-center gap-1 border border-ink bg-ink px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-card hover:bg-ink/90"
            >
              <Download className="h-3 w-3" />
              <span>TÉLÉCHARGER .SVG</span>
            </button>
            <button
              type="button"
              onClick={() => handleCopySvg(content.svg)}
              className="inline-flex items-center gap-1 border border-border bg-card px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink"
            >
              <Copy className="h-3 w-3" />
              <span>{copiedSvg ? "COPIÉ !" : "COPIER SVG"}</span>
            </button>
            <button
              type="button"
              onClick={() => setSvgFullscreen((p) => !p)}
              className="border border-border bg-card p-1 text-ink hover:border-ink"
              title="Plein écran"
            >
              {svgFullscreen ? (
                <Minimize2 className="h-3.5 w-3.5" />
              ) : (
                <Maximize2 className="h-3.5 w-3.5" />
              )}
            </button>
          </div>
        </div>

        <div
          className={`overflow-auto bg-paper p-2 ${
            svgFullscreen ? "flex-1" : compact ? "max-h-72" : ""
          }`}
        >
          <div
            className="mx-auto w-full max-w-[920px]"
            dangerouslySetInnerHTML={{ __html: content.svg }}
          />
        </div>
      </div>
    );
  }

  if (content.kind === "FLASHCARDS") {
    const cards = content.cards || [];
    const safeIdx = Math.min(cardIndex, Math.max(0, cards.length - 1));
    const currentCard = cards[safeIdx];
    const masteredCount = cards.filter((c) => masteredIds[c.id]).length;

    if (!currentCard) {
      return (
        <div className="border border-border bg-paper p-4 font-mono text-xs text-stone">
          AUCUNE FLASHCARD GÉNÉRÉE.
        </div>
      );
    }

    return (
      <div className="border border-ink bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-paper px-3 py-2 font-mono text-[10px] uppercase tracking-wider">
          <span className="font-bold text-ink">
            FLASHCARDS · CARTE {safeIdx + 1} / {cards.length}
          </span>
          <span className="text-forest">
            MAÎTRISÉES : {masteredCount} / {cards.length}
          </span>
        </div>

        <div className="p-4">
          <button
            type="button"
            onClick={() => setFlipped((p) => !p)}
            className={`flex w-full flex-col justify-between border border-ink p-5 text-left transition-colors ${
              compact ? "min-h-[150px]" : "min-h-[200px]"
            } ${flipped ? "bg-pinned" : "bg-paper"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="bg-badge-bg px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-badge-text">
                {flipped ? "VERSO · RÉPONSE" : "RECTO · QUESTION"}
              </span>
              <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-stone">
                <RotateCw className="h-3 w-3" />
                <span>CLIQUER POUR RETOURNER</span>
              </span>
            </div>

            <p className="my-4 text-sm font-semibold leading-relaxed text-ink">
              {flipped ? currentCard.back : currentCard.front}
            </p>

            <div className="flex items-center justify-between border-t border-border pt-2 font-mono text-[10px] uppercase tracking-wider text-stone">
              <span>{currentCard.tag}</span>
              <span>
                {currentCard.fileName} · P.{currentCard.pageNumber}
              </span>
            </div>
          </button>

          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setFlipped(false);
                  setCardIndex((i) => Math.max(0, i - 1));
                }}
                disabled={safeIdx === 0}
                className="border border-border bg-paper px-2.5 py-1.5 font-mono text-[10px] uppercase text-ink hover:border-ink disabled:opacity-40"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setFlipped(false);
                  setCardIndex((i) => Math.min(cards.length - 1, i + 1));
                }}
                disabled={safeIdx >= cards.length - 1}
                className="border border-border bg-paper px-2.5 py-1.5 font-mono text-[10px] uppercase text-ink hover:border-ink disabled:opacity-40"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => {
                  setMasteredIds((prev) => ({
                    ...prev,
                    [currentCard.id]: false,
                  }));
                  setFlipped(false);
                  if (safeIdx < cards.length - 1) setCardIndex(safeIdx + 1);
                }}
                className="border border-border bg-paper px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-stone hover:border-ink hover:text-ink"
              >
                À REVOIR
              </button>
              <button
                type="button"
                onClick={() => {
                  setMasteredIds((prev) => ({
                    ...prev,
                    [currentCard.id]: true,
                  }));
                  setFlipped(false);
                  if (safeIdx < cards.length - 1) setCardIndex(safeIdx + 1);
                }}
                className="inline-flex items-center gap-1 border border-forest bg-forest/10 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-forest hover:bg-forest hover:text-card"
              >
                <Check className="h-3 w-3" />
                <span>MAÎTRISÉE</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (content.kind === "QUIZ") {
    const questions = content.questions || [];
    const checkCorrect = (q: RevisionQuestion): boolean => {
      const ans = quizAnswers[q.id];
      if (q.type === "FILL_BLANK") {
        const g = typeof ans === "string" ? normalizeTextForMatch(ans) : "";
        const e = q.correctAnswer ? normalizeTextForMatch(q.correctAnswer) : "";
        return Boolean(e && g === e);
      }
      const sel = Array.isArray(ans) ? [...ans].sort((a, b) => a - b) : [];
      const exp = [...(q.correctIndices || [])].sort((a, b) => a - b);
      return (
        exp.length > 0 &&
        sel.length === exp.length &&
        sel.every((v, idx) => v === exp[idx])
      );
    };

    const score = quizSubmitted
      ? questions.filter((q) => checkCorrect(q)).length
      : 0;

    return (
      <div className="border border-ink bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-paper px-3 py-2 font-mono text-[10px] uppercase tracking-wider">
          <span className="font-bold text-ink">
            QUIZ STUDIO ({questions.length} QUESTIONS)
          </span>
          {quizSubmitted && (
            <span className="bg-badge-bg px-2 py-0.5 font-bold text-badge-text">
              SCORE : {score} / {questions.length}
            </span>
          )}
        </div>

        <div className="space-y-3 p-3.5">
          {questions.map((q, idx) => {
            const isOk = quizSubmitted ? checkCorrect(q) : undefined;
            return (
              <div
                key={q.id}
                className={`border p-3 ${
                  quizSubmitted && isOk === true
                    ? "border-forest bg-forest/5"
                    : quizSubmitted && isOk === false
                    ? "border-carmine bg-carmine/5"
                    : "border-border bg-paper"
                }`}
              >
                <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-stone">
                  Q{idx + 1} · {q.type} · {q.fileName} (P.{q.pageNumber})
                </p>
                <p className="mb-2.5 text-xs font-semibold text-ink">
                  {q.prompt}
                </p>

                {(q.type === "QCU" || q.type === "QCM") && q.options && (
                  <div className="space-y-1.5">
                    {q.options.map((opt, optIdx) => {
                      const sel = Array.isArray(quizAnswers[q.id])
                        ? (quizAnswers[q.id] as number[])
                        : [];
                      const active = sel.includes(optIdx);
                      const expected = q.correctIndices?.includes(optIdx);
                      return (
                        <button
                          key={optIdx}
                          type="button"
                          disabled={quizSubmitted}
                          onClick={() => {
                            if (q.type === "QCU") {
                              setQuizAnswers((p) => ({ ...p, [q.id]: [optIdx] }));
                            } else {
                              const next = active
                                ? sel.filter((i) => i !== optIdx)
                                : [...sel, optIdx];
                              setQuizAnswers((p) => ({ ...p, [q.id]: next }));
                            }
                          }}
                          className={`flex w-full items-start gap-2 border px-2.5 py-1.5 text-left text-xs ${
                            quizSubmitted && expected
                              ? "border-forest bg-forest/10"
                              : quizSubmitted && active && !expected
                              ? "border-carmine bg-carmine/10"
                              : active
                              ? "border-ink bg-pinned"
                              : "border-border bg-card"
                          }`}
                        >
                          <span className="font-mono text-[10px] font-bold">
                            {active ? "[✓]" : "[ ]"}
                          </span>
                          <span>{opt}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {q.type === "FILL_BLANK" && (
                  <div className="space-y-2">
                    <p className="border border-border bg-card p-2 text-xs text-ink">
                      {q.sentenceWithBlank}
                    </p>
                    <input
                      type="text"
                      disabled={quizSubmitted}
                      value={
                        typeof quizAnswers[q.id] === "string"
                          ? (quizAnswers[q.id] as string)
                          : ""
                      }
                      onChange={(e) =>
                        setQuizAnswers((p) => ({
                          ...p,
                          [q.id]: e.target.value,
                        }))
                      }
                      placeholder="Compléter le terme..."
                      className="w-full border border-border bg-card px-2.5 py-1.5 font-mono text-xs text-ink"
                    />
                  </div>
                )}

                {quizSubmitted && (
                  <p className="mt-2 border-t border-border pt-1.5 text-[11px] text-stone">
                    {q.explanation}
                  </p>
                )}
              </div>
            );
          })}

          <div className="flex justify-end gap-2">
            {quizSubmitted ? (
              <button
                type="button"
                onClick={() => {
                  setQuizAnswers({});
                  setQuizSubmitted(false);
                }}
                className="border border-border bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink"
              >
                RECOMMENCER
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setQuizSubmitted(true)}
                className="border border-ink bg-ink px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider text-card hover:bg-ink/90"
              >
                CORRIGER LE QUIZ
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // SUMMARY
  return (
    <div className="border border-ink bg-card">
      <div className="border-b border-border bg-paper px-3 py-2 font-mono text-[11px] font-bold uppercase tracking-wider text-ink">
        FICHE SYNTHÈSE NOTEBOOK · {title}
      </div>
      <div className="space-y-4 p-4">
        <p className="text-xs leading-relaxed text-ink">{content.overview}</p>

        {content.keyConcepts.length > 0 && (
          <div className="space-y-1.5">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-stone">
              NOTIONS CLÉS :
            </p>
            <div className="divide-y divide-border border border-border">
              {content.keyConcepts.map((kc, idx) => (
                <div key={idx} className="bg-paper p-2.5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-bold text-ink">
                      {kc.term}
                    </span>
                    {onOpenSource ? (
                      <button
                        type="button"
                        onClick={() =>
                          onOpenSource({
                            documentId: kc.documentId,
                            documentTitle: kc.term,
                            fileName: kc.sourceLabel,
                            pageNumber: kc.pageNumber,
                            ueId: kc.ueId,
                            ueCode: "",
                            label: kc.sourceLabel,
                          })
                        }
                        className="inline-flex items-center gap-1 bg-badge-bg px-1.5 py-0.5 font-mono text-[9px] uppercase text-badge-text hover:bg-badge-text hover:text-card"
                      >
                        <FileText className="h-2.5 w-2.5" />
                        {kc.sourceLabel}
                      </button>
                    ) : (
                      <span className="bg-badge-bg px-1.5 py-0.5 font-mono text-[9px] uppercase text-badge-text">
                        {kc.sourceLabel}
                      </span>
                    )}
                  </div>
                  <p className="mt-1 text-xs text-stone">{kc.definition}</p>
                </div>
              ))}
            </div>
          </div>
        )}

        {content.examPitfalls.length > 0 && (
          <div className="border border-border bg-pinned p-3">
            <p className="mb-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink">
              POINTS DE VIGILANCE PARTIELS :
            </p>
            <ul className="list-disc space-y-1 pl-4 text-xs text-ink">
              {content.examPitfalls.map((p, idx) => (
                <li key={idx}>{p}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
