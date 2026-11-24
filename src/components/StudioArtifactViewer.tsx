"use client";

import { Fragment, useCallback, useEffect, useState, type ReactNode } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Copy,
  Download,
  FileText,
  Flag,
  Loader2,
  Maximize2,
  Minimize2,
  Pencil,
  Plus,
  Printer,
  Save,
  Trash2,
  X,
} from "lucide-react";
import {
  buildAnkiTsvExport,
  buildFlashcardKey,
  buildFlashcardsCsvExport,
  buildSummaryMarkdownExport,
} from "@/lib/artifact-export";
import { isRevisionQuestionCorrect } from "@/lib/question-grading";
import type { RevisionQuestion } from "@/lib/revisions";
import type {
  FlashcardItem,
  StudioArtifactContent,
  StudioSourceRef,
  SummaryPayload,
} from "@/lib/studio";

const OPTION_LETTERS = ["A", "B", "C", "D"];

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatInlineToHtml(raw: string): string {
  const escaped = escapeHtml(raw);
  return escaped
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function renderFormattedText(text: string): ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*|\*[^*]+\*)/g);
  return parts.map((part, idx) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={idx} className="font-bold text-ink">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("*") && part.endsWith("*") && part.length > 2) {
      return (
        <em key={idx} className="italic">
          {part.slice(1, -1)}
        </em>
      );
    }
    return <Fragment key={idx}>{part}</Fragment>;
  });
}

function buildPrintableSummaryHtml(title: string, summary: SummaryPayload): string {
  const sectionsHtml = (summary.sections || [])
    .map((sec, sIdx) => {
      const subsHtml = (sec.subsections || [])
        .map((sub) => {
          const calloutsHtml = (sub.callouts || [])
            .map((c) => {
              const itemsHtml =
                c.items && c.items.length > 0
                  ? `<ol>${c.items
                      .map((it) => `<li>${formatInlineToHtml(it)}</li>`)
                      .join("")}</ol>`
                  : "";
              const textHtml = c.text
                ? `<p>${formatInlineToHtml(c.text)}</p>`
                : "";
              return `<div class="callout">
                <div class="callout-title">${escapeHtml(c.icon || "💡")} ${escapeHtml(
                c.title
              )} :</div>
                ${textHtml}
                ${itemsHtml}
              </div>`;
            })
            .join("");

          const bulletsHtml =
            sub.bullets && sub.bullets.length > 0
              ? `<ul>${sub.bullets
                  .map((b) => {
                    const subList =
                      b.subItems && b.subItems.length > 0
                        ? `<ul>${b.subItems
                            .map((si) => `<li>${formatInlineToHtml(si)}</li>`)
                            .join("")}</ul>`
                        : "";
                    const lead = b.lead
                      ? `<strong>${escapeHtml(b.lead)}</strong> : `
                      : "";
                    return `<li>${lead}${formatInlineToHtml(b.text)}${subList}</li>`;
                  })
                  .join("")}</ul>`
              : "";

          const tableHtml =
            sub.table && sub.table.headers.length > 0 && sub.table.rows.length > 0
              ? `<table>
                  <thead><tr>${sub.table.headers
                    .map((h) => `<th>${escapeHtml(h)}</th>`)
                    .join("")}</tr></thead>
                  <tbody>${sub.table.rows
                    .map(
                      (row) =>
                        `<tr>${row
                          .map((cell) => `<td>${formatInlineToHtml(cell)}</td>`)
                          .join("")}</tr>`
                    )
                    .join("")}</tbody>
                </table>`
              : "";

          return `<div class="subsection">
            <h3>${escapeHtml(sub.icon || "📌")} ${escapeHtml(sub.title)}</h3>
            ${sub.intro ? `<p class="intro">${formatInlineToHtml(sub.intro)}</p>` : ""}
            ${calloutsHtml}
            ${bulletsHtml}
            ${tableHtml}
          </div>`;
        })
        .join("");

      const fallbackPointsHtml =
        (!sec.subsections || sec.subsections.length === 0) &&
        sec.keyPoints &&
        sec.keyPoints.length > 0
          ? `<p>${formatInlineToHtml(sec.content)}</p><ul>${sec.keyPoints
              .map((kp) => `<li>${formatInlineToHtml(kp)}</li>`)
              .join("")}</ul>`
          : "";

      return `<section class="chapter">
        <h2><span>${sIdx + 1}. ${escapeHtml(sec.title)}</span>${
          sec.pageRange
            ? `<span class="chapter-pages">${escapeHtml(sec.pageRange)}</span>`
            : ""
        }</h2>
        ${subsHtml || fallbackPointsHtml}
      </section>`;
    })
    .join("");

  const conceptsHtml =
    summary.keyConcepts && summary.keyConcepts.length > 0
      ? `<section class="chapter glossary-section">
          <h2><span>Glossaire &amp; Notions clés du cours</span><span class="chapter-pages">${summary.keyConcepts.length} NOTIONS</span></h2>
          <table>
            <thead><tr><th style="width:28%">Notion</th><th>Définition &amp; mécanisme clé</th><th style="width:18%">Source</th></tr></thead>
            <tbody>${summary.keyConcepts
              .map(
                (kc) =>
                  `<tr><td><strong>${formatInlineToHtml(kc.term)}</strong></td><td>${formatInlineToHtml(
                    kc.definition
                  )}</td><td style="font-size:8pt;color:#64748b">${escapeHtml(
                    kc.sourceLabel || `P.${kc.pageNumber || 1}`
                  )}</td></tr>`
              )
              .join("")}</tbody>
          </table>
        </section>`
      : "";

  const pitfallsHtml =
    summary.examPitfalls.length > 0
      ? `<div class="callout">
          <div class="callout-title">⚠️ Points de vigilance &amp; pièges fréquents en partiel :</div>
          <ul>${summary.examPitfalls
            .map((p) => `<li>${formatInlineToHtml(p)}</li>`)
            .join("")}</ul>
        </div>`
      : "";

  const hasCleanOverview =
    Boolean(summary.overview) &&
    !summary.overview.trim().startsWith("[") &&
    summary.overview.length <= 420;

  const tocHtml =
    summary.sections && summary.sections.length >= 2
      ? `<div class="toc">
          <div class="toc-title">Plan de la fiche</div>
          <ol>${summary.sections
            .map(
              (s) =>
                `<li><span>${escapeHtml(s.title)}</span> <span class="toc-page">${escapeHtml(
                  s.pageRange
                )}</span></li>`
            )
            .join("")}</ol>
        </div>`
      : "";

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<style>
  @page { margin: 16mm 15mm; }
  body { font-family: "Segoe UI", system-ui, -apple-system, sans-serif; color: #1e293b; line-height: 1.5; font-size: 10.5pt; margin: 0; padding: 0; }
  .top-bar { border-bottom: 3px solid #4f46e5; padding-bottom: 8px; margin-bottom: 14px; display: flex; justify-content: space-between; font-size: 9pt; color: #64748b; }
  h1 { font-size: 19pt; font-weight: 800; color: #0f172a; margin: 6px 0 12px; border-bottom: 1px solid #cbd5e1; padding-bottom: 8px; }
  .overview { font-size: 10pt; color: #475569; margin: 0 0 12px; }
  .toc { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 4px; padding: 8px 14px; margin-bottom: 16px; font-size: 9.5pt; }
  .toc-title { font-weight: 700; text-transform: uppercase; font-size: 8.5pt; letter-spacing: 0.05em; color: #64748b; margin-bottom: 4px; }
  .toc ol { margin: 0 0 0 18px; padding: 0; }
  .toc li { margin-bottom: 2px; }
  .toc-page { color: #64748b; font-size: 8.5pt; margin-left: 4px; }
  .chapter { border-top: 1px dashed #cbd5e1; padding-top: 12px; margin-top: 16px; }
  .chapter:first-of-type { border-top: none; padding-top: 0; margin-top: 0; }
  h2 { font-size: 13.5pt; font-weight: 700; color: #0f172a; border-bottom: 1px solid #e2e8f0; padding-bottom: 5px; margin: 0 0 10px; display: flex; justify-content: space-between; align-items: baseline; gap: 12px; break-after: avoid; page-break-after: avoid; }
  .chapter-pages { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 8.5pt; font-weight: 600; color: #3d6b99; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 3px; padding: 1px 6px; white-space: nowrap; }
  .subsection { margin-bottom: 12px; }
  h3 { font-size: 11pt; font-weight: 700; color: #3b5bdb; margin: 10px 0 6px; break-after: avoid; page-break-after: avoid; }
  .callout { background: #fef9e7; border-left: 3px solid #d99b26; border-radius: 4px; padding: 9px 12px; margin: 8px 0; break-inside: avoid; page-break-inside: avoid; }
  .callout-title { font-weight: 700; color: #0f172a; margin-bottom: 4px; }
  ul, ol { margin: 5px 0 8px 20px; padding: 0; }
  li { margin-bottom: 3.5px; }
  table { width: 100%; border-collapse: collapse; margin: 9px 0; font-size: 9.5pt; break-inside: avoid; page-break-inside: avoid; }
  .glossary-section table { break-inside: auto; page-break-inside: auto; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  th { background: #f1f5f9; text-align: left; font-weight: 700; border-bottom: 1px solid #cbd5e1; padding: 6px 8px; }
  td { border-bottom: 1px solid #e2e8f0; padding: 6px 8px; }
  .footer-end { margin-top: 22px; border-top: 1px solid #cbd5e1; padding-top: 10px; text-align: center; font-size: 9pt; color: #64748b; }
</style>
</head>
<body>
  <div class="top-bar">
    <span><strong>ARA</strong> · Oniris Vétérinaire</span>
    <span>Exporté le ${new Date().toLocaleDateString("fr-FR")}</span>
  </div>
  <h1>${escapeHtml(title)}</h1>
  ${hasCleanOverview ? `<p class="overview">${formatInlineToHtml(summary.overview)}</p>` : ""}
  ${tocHtml}
  ${sectionsHtml}
  ${conceptsHtml}
  ${pitfallsHtml}
  <div class="footer-end">— Fin — · Généré localement par ARA</div>
</body>
</html>`;
}

interface StudioArtifactViewerProps {
  artifactId?: string;
  ueId?: string;
  ueCode?: string;
  documentId?: string | null;
  title: string;
  content: StudioArtifactContent;
  compact?: boolean;
  canEdit?: boolean;
  onArtifactUpdated?: (content: StudioArtifactContent, newTitle?: string) => void;
  onOpenSource?: (source: StudioSourceRef) => void;
}

export function StudioArtifactViewer({
  artifactId,
  ueId,
  ueCode,
  documentId,
  title,
  content,
  compact = false,
  canEdit = false,
  onArtifactUpdated,
  onOpenSource,
}: StudioArtifactViewerProps) {
  // SVG state
  const [svgFullscreen, setSvgFullscreen] = useState(false);
  const [copiedSvg, setCopiedSvg] = useState(false);

  // Flashcards SRS state
  const [cardIndex, setCardIndex] = useState(0);
  const [cardFilter, setCardFilter] = useState<"ALL" | "DUE" | "REVIEW">("ALL");
  const [flipped, setFlipped] = useState(false);
  const [masteredIds, setMasteredIds] = useState<Record<string, boolean>>({});
  const [srsRatings, setSrsRatings] = useState<
    Record<string, "AGAIN" | "HARD" | "GOOD" | "EASY">
  >({});
  const [srsByCardKey, setSrsByCardKey] = useState<
    Record<
      string,
      {
        rating: "AGAIN" | "HARD" | "GOOD" | "EASY";
        nextReviewDate: string;
        mastered: boolean;
      }
    >
  >({});
  const [todayKey, setTodayKey] = useState<string>("");
  const [cardTouchStartX, setCardTouchStartX] = useState<number | null>(null);

  // Quiz state
  const [quizAnswers, setQuizAnswers] = useState<
    Record<string, number[] | string>
  >({});
  const [quizSubmitted, setQuizSubmitted] = useState(false);
  const [missedRecordedCount, setMissedRecordedCount] = useState<number | null>(
    null
  );

  // Inline Edit & Reporting state
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(title);
  const [editDraft, setEditDraft] = useState<StudioArtifactContent | null>(
    null
  );
  const [savingEdit, setSavingEdit] = useState(false);
  const [editStatusMsg, setEditStatusMsg] = useState<string | null>(null);

  const [reportOpen, setReportOpen] = useState(false);
  const [reportItemLabel, setReportItemLabel] = useState("");
  const [reportDescription, setReportDescription] = useState("");
  const [reportBusy, setReportBusy] = useState(false);
  const [reportSuccess, setReportSuccess] = useState<string | null>(null);

  useEffect(() => {
    setEditTitle(title);
    setEditDraft(null);
    setIsEditing(false);
    setEditStatusMsg(null);
  }, [artifactId, title]);

  const isFlashcards = content.kind === "FLASHCARDS";

  useEffect(() => {
    if (!isFlashcards || !artifactId) return;
    let active = true;
    fetch(`/api/studio/srs?artifactId=${encodeURIComponent(artifactId)}`, {
      cache: "no-store",
    })
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (
          data: {
            todayKey?: string;
            reviews?: Record<
              string,
              {
                rating: "AGAIN" | "HARD" | "GOOD" | "EASY";
                nextReviewDate: string;
                mastered: boolean;
              }
            >;
          } | null
        ) => {
          if (!active || !data) return;
          if (data.todayKey) setTodayKey(data.todayKey);
          if (data.reviews) {
            setSrsByCardKey(data.reviews);
            const nextMastered: Record<string, boolean> = {};
            const nextRatings: Record<
              string,
              "AGAIN" | "HARD" | "GOOD" | "EASY"
            > = {};
            const cards = content.kind === "FLASHCARDS" ? content.cards || [] : [];
            for (const c of cards) {
              const rev = data.reviews[buildFlashcardKey(c.front)];
              if (rev) {
                nextMastered[c.id] = Boolean(rev.mastered);
                nextRatings[c.id] = rev.rating;
              }
            }
            setMasteredIds(nextMastered);
            setSrsRatings(nextRatings);
          }
        }
      )
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [isFlashcards, artifactId, content]);

  const allCards = isFlashcards ? content.cards || [] : [];
  const unmasteredCards = allCards.filter((c) => !masteredIds[c.id]);
  const dueCards = allCards.filter((c) => {
    const rev = srsByCardKey[buildFlashcardKey(c.front)];
    if (!rev) return true;
    if (rev.mastered) return false;
    return !todayKey || rev.nextReviewDate <= todayKey;
  });
  const visibleCards =
    cardFilter === "DUE" && dueCards.length > 0
      ? dueCards
      : cardFilter === "REVIEW" && unmasteredCards.length > 0
      ? unmasteredCards
      : allCards;
  const safeCardIdx = Math.min(
    cardIndex,
    Math.max(0, visibleCards.length - 1)
  );

  const handlePrevCard = useCallback(() => {
    setFlipped(false);
    setCardIndex((i) => Math.max(0, i - 1));
  }, []);

  const handleNextCard = useCallback(() => {
    setFlipped(false);
    setCardIndex((i) =>
      Math.min(Math.max(0, visibleCards.length - 1), i + 1)
    );
  }, [visibleCards.length]);

  // Keyboard shortcuts ("Space" to flip, "←/→" to navigate) for Flashcards
  useEffect(() => {
    if (!isFlashcards || visibleCards.length === 0 || isEditing) return;

    function onKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable)
      ) {
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        setFlipped((p) => !p);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        handlePrevCard();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        handleNextCard();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isFlashcards, visibleCards.length, isEditing, handlePrevCard, handleNextCard]);

  function downloadFileWithSlug(
    fileContent: string,
    ext: string,
    mimeType: string
  ) {
    const blob = new Blob([fileContent], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const slug =
      title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "ara-export";
    a.href = url;
    a.download = `${slug}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function handleDownloadSvg(svgMarkup: string) {
    downloadFileWithSlug(svgMarkup, "svg", "image/svg+xml;charset=utf-8");
  }

  function startInlineEdit() {
    setEditDraft(JSON.parse(JSON.stringify(content)) as StudioArtifactContent);
    setEditTitle(title);
    setIsEditing(true);
    setEditStatusMsg(null);
  }

  async function saveInlineEdit() {
    if (!artifactId || !editDraft || savingEdit) return;
    setSavingEdit(true);
    setEditStatusMsg(null);
    try {
      const res = await fetch(`/api/studio/${artifactId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: editTitle.trim() || title,
          content: editDraft,
        }),
      });
      if (!res.ok) {
        setEditStatusMsg("Erreur lors de l'enregistrement des modifications.");
        return;
      }
      onArtifactUpdated?.(editDraft, editTitle.trim() || title);
      setIsEditing(false);
      setEditStatusMsg("Modifications enregistrées.");
    } finally {
      setSavingEdit(false);
    }
  }

  async function submitIssueReport(defaultLabel: string) {
    if (reportDescription.trim().length < 4 || reportBusy) return;
    setReportBusy(true);
    try {
      const res = await fetch("/api/studio/reports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ueId,
          ueCode,
          documentId,
          artifactId,
          targetKind: content.kind,
          itemLabel: (reportItemLabel || defaultLabel).slice(0, 160),
          description: reportDescription.trim(),
        }),
      });
      if (res.ok) {
        setReportOpen(false);
        setReportDescription("");
        setReportSuccess(
          "Signalement envoyé aux responsables. Merci pour votre aide !"
        );
      }
    } finally {
      setReportBusy(false);
    }
  }

  function renderReportBlock(defaultLabel: string) {
    return (
      <div className="border-t border-border bg-paper/60 px-3.5 py-2.5">
        {reportSuccess && (
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-wider text-forest">
            ✓ {reportSuccess}
          </p>
        )}
        {!reportOpen ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {editStatusMsg && (
              <span className="font-mono text-[10px] uppercase tracking-wider text-forest">
                ✓ {editStatusMsg}
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                setReportItemLabel(defaultLabel);
                setReportOpen(true);
                setReportSuccess(null);
              }}
              className="ml-auto inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-stone hover:text-carmine"
            >
              <Flag className="h-3 w-3" />
              <span>SIGNALER UNE ERREUR</span>
            </button>
          </div>
        ) : (
          <div className="space-y-2">
            <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-ink">
              SIGNALEMENT : {reportItemLabel || defaultLabel}
            </p>
            <textarea
              rows={2}
              value={reportDescription}
              onChange={(e) => setReportDescription(e.target.value)}
              placeholder="Précisez l'erreur repérée (valeur, réponse, formulation)..."
              className="w-full border border-border bg-card px-2.5 py-1.5 text-xs text-ink focus:border-ink focus:outline-none"
            />
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setReportOpen(false);
                  setReportDescription("");
                }}
                className="border border-border bg-card px-2.5 py-1 font-mono text-[10px] uppercase text-stone hover:text-ink"
              >
                ANNULER
              </button>
              <button
                type="button"
                disabled={reportBusy || reportDescription.trim().length < 4}
                onClick={() => void submitIssueReport(defaultLabel)}
                className="border border-carmine bg-carmine px-3 py-1 font-mono text-[10px] font-semibold uppercase text-card disabled:opacity-50"
              >
                {reportBusy ? "ENVOI..." : "ENVOYER LE SIGNALEMENT"}
              </button>
            </div>
          </div>
        )}
      </div>
    );
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

  function handlePrintSummaryPdf(summaryPayload: SummaryPayload) {
    const html = buildPrintableSummaryHtml(title, summaryPayload);
    const iframe = document.createElement("iframe");
    iframe.style.position = "fixed";
    iframe.style.right = "0";
    iframe.style.bottom = "0";
    iframe.style.width = "0";
    iframe.style.height = "0";
    iframe.style.border = "0";
    document.body.appendChild(iframe);

    const doc = iframe.contentWindow?.document;
    if (!doc) {
      iframe.remove();
      return;
    }
    doc.open();
    doc.write(html);
    doc.close();

    setTimeout(() => {
      iframe.contentWindow?.focus();
      iframe.contentWindow?.print();
      setTimeout(() => iframe.remove(), 1500);
    }, 200);
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
    const currentCard = visibleCards[safeCardIdx];
    const masteredCount = allCards.length - unmasteredCards.length;
    const reviewCount = Object.values(srsRatings).filter(
      (r) => r === "AGAIN" || r === "HARD"
    ).length;

    if (allCards.length === 0 || !currentCard) {
      return (
        <div className="border border-border bg-paper p-4 font-mono text-xs text-stone">
          AUCUNE FLASHCARD GÉNÉRÉE.
        </div>
      );
    }

    const batchRanges: Array<{ start: number; end: number; label: string }> = [];
    if (visibleCards.length > 10) {
      for (let i = 0; i < visibleCards.length; i += 10) {
        const end = Math.min(i + 10, visibleCards.length);
        batchRanges.push({ start: i, end, label: `${i + 1}–${end}` });
      }
    }

    const gradeCard = (
      rating: "AGAIN" | "HARD" | "GOOD" | "EASY",
      mastered: boolean
    ) => {
      const card = currentCard;
      const cKey = buildFlashcardKey(card.front);
      setMasteredIds((prev) => ({
        ...prev,
        [card.id]: mastered,
      }));
      setSrsRatings((prev) => ({
        ...prev,
        [card.id]: rating,
      }));
      setSrsByCardKey((prev) => ({
        ...prev,
        [cKey]: {
          rating,
          mastered,
          nextReviewDate:
            rating === "AGAIN"
              ? todayKey || "2099-01-01"
              : "2099-01-01",
        },
      }));
      if (artifactId) {
        void fetch("/api/studio/srs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            artifactId,
            cardKey: cKey,
            front: card.front,
            ueId: ueId || card.ueId,
            ueCode: ueCode || "",
            documentId: documentId || card.documentId,
            rating,
          }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then(
            (
              d: {
                review?: {
                  rating: "AGAIN" | "HARD" | "GOOD" | "EASY";
                  nextReviewDate: string;
                  mastered: boolean;
                };
              } | null
            ) => {
              if (d?.review) {
                setSrsByCardKey((prev) => ({ ...prev, [cKey]: d.review! }));
                setMasteredIds((prev) => ({
                  ...prev,
                  [card.id]: Boolean(d.review!.mastered),
                }));
              }
            }
          )
          .catch(() => null);
      }
      setFlipped(false);
      if (safeCardIdx < visibleCards.length - 1) {
        setCardIndex(safeCardIdx + 1);
      }
    };

    const editingCardsDraft =
      isEditing && editDraft?.kind === "FLASHCARDS"
        ? editDraft.cards
        : (null as FlashcardItem[] | null);

    return (
      <div className="border border-ink bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-paper px-3 py-2 font-mono text-[10px] uppercase tracking-wider">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-ink">{title}</span>
            <span className="text-stone">
              · {safeCardIdx + 1}/{visibleCards.length}
            </span>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                setCardFilter("ALL");
                setCardIndex(0);
                setFlipped(false);
              }}
              className={`border px-2 py-0.5 text-[9px] ${
                cardFilter === "ALL"
                  ? "border-ink bg-ink text-card"
                  : "border-border bg-card text-stone hover:text-ink"
              }`}
            >
              TOUTES ({allCards.length})
            </button>
            <button
              type="button"
              disabled={dueCards.length === 0}
              onClick={() => {
                setCardFilter("DUE");
                setCardIndex(0);
                setFlipped(false);
              }}
              className={`border px-2 py-0.5 text-[9px] disabled:opacity-40 ${
                cardFilter === "DUE"
                  ? "border-badge-text bg-badge-text text-card"
                  : "border-border bg-card text-badge-text hover:border-badge-text"
              }`}
            >
              DUES ({dueCards.length})
            </button>
            <button
              type="button"
              disabled={unmasteredCards.length === 0}
              onClick={() => {
                setCardFilter("REVIEW");
                setCardIndex(0);
                setFlipped(false);
              }}
              className={`border px-2 py-0.5 text-[9px] disabled:opacity-40 ${
                cardFilter === "REVIEW"
                  ? "border-ink bg-ink text-card"
                  : "border-border bg-card text-stone hover:text-ink"
              }`}
            >
              À REVOIR ({unmasteredCards.length})
            </button>

            <button
              type="button"
              onClick={() =>
                downloadFileWithSlug(
                  buildAnkiTsvExport(title, allCards, ueCode),
                  "tsv",
                  "text/tab-separated-values;charset=utf-8"
                )
              }
              title="Exporter pour Anki (.tsv)"
              className="inline-flex items-center gap-1 border border-border bg-card px-2 py-0.5 text-[9px] text-ink hover:border-ink"
            >
              <Download className="h-2.5 w-2.5" />
              <span>ANKI (.TSV)</span>
            </button>

            <button
              type="button"
              onClick={() =>
                downloadFileWithSlug(
                  buildFlashcardsCsvExport(allCards),
                  "csv",
                  "text/csv;charset=utf-8"
                )
              }
              title="Exporter en CSV"
              className="inline-flex items-center gap-1 border border-border bg-card px-2 py-0.5 text-[9px] text-ink hover:border-ink"
            >
              <Download className="h-2.5 w-2.5" />
              <span>.CSV</span>
            </button>

            {canEdit && artifactId && (
              <button
                type="button"
                onClick={() =>
                  isEditing ? setIsEditing(false) : startInlineEdit()
                }
                className={`inline-flex items-center gap-1 border px-2 py-0.5 text-[9px] font-bold ${
                  isEditing
                    ? "border-carmine bg-carmine text-card"
                    : "border-ink bg-card text-ink hover:bg-pinned"
                }`}
              >
                <Pencil className="h-2.5 w-2.5" />
                <span>{isEditing ? "QUITTER ÉDITION" : "ÉDITER"}</span>
              </button>
            )}
          </div>
        </div>

        {isEditing && editingCardsDraft ? (
          <div className="space-y-4 p-4">
            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                TITRE DU PAQUET DE FLASHCARDS
              </label>
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full border border-border bg-paper px-3 py-1.5 text-sm font-bold text-ink focus:border-ink focus:outline-none"
              />
            </div>

            <div className="max-h-[420px] space-y-3 overflow-y-auto pr-1">
              {editingCardsDraft.map((fc, idx) => (
                <div
                  key={fc.id || idx}
                  className="space-y-2 border border-border bg-paper p-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[10px] font-bold uppercase text-stone">
                      CARTE #{idx + 1} · P.{fc.pageNumber}
                    </span>
                    <button
                      type="button"
                      disabled={editingCardsDraft.length <= 1}
                      onClick={() => {
                        setEditDraft({
                          kind: "FLASHCARDS",
                          sources: content.sources,
                          cards: editingCardsDraft.filter((_, i) => i !== idx),
                        });
                      }}
                      className="inline-flex items-center gap-1 font-mono text-[9px] uppercase text-carmine hover:underline disabled:opacity-40"
                    >
                      <Trash2 className="h-3 w-3" />
                      <span>SUPPRIMER</span>
                    </button>
                  </div>
                  <input
                    type="text"
                    value={fc.front}
                    onChange={(e) => {
                      const next = editingCardsDraft.map((item, i) =>
                        i === idx ? { ...item, front: e.target.value } : item
                      );
                      setEditDraft({
                        kind: "FLASHCARDS",
                        sources: content.sources,
                        cards: next,
                      });
                    }}
                    placeholder="Question recto"
                    className="w-full border border-border bg-card px-2.5 py-1.5 text-xs font-semibold text-ink"
                  />
                  <textarea
                    rows={2}
                    value={fc.back}
                    onChange={(e) => {
                      const next = editingCardsDraft.map((item, i) =>
                        i === idx ? { ...item, back: e.target.value } : item
                      );
                      setEditDraft({
                        kind: "FLASHCARDS",
                        sources: content.sources,
                        cards: next,
                      });
                    }}
                    placeholder="Réponse verso"
                    className="w-full border border-border bg-card px-2.5 py-1.5 text-xs text-ink"
                  />
                </div>
              ))}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                className="border border-border bg-paper px-3 py-1.5 font-mono text-[10px] uppercase text-stone hover:text-ink"
              >
                ANNULER
              </button>
              <button
                type="button"
                disabled={savingEdit}
                onClick={() => void saveInlineEdit()}
                className="inline-flex items-center gap-1.5 border border-ink bg-ink px-4 py-1.5 font-mono text-[10px] font-semibold uppercase text-card disabled:opacity-50"
              >
                {savingEdit ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Save className="h-3 w-3" />
                )}
                <span>ENREGISTRER LES MODIFICATIONS</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="p-4 sm:p-5">
            {batchRanges.length > 0 && (
              <div className="mb-3 flex flex-wrap items-center gap-1">
                <span className="mr-1 font-mono text-[9px] uppercase text-stone">
                  LOTS :
                </span>
                {batchRanges.map((b) => {
                  const activeBatch =
                    safeCardIdx >= b.start && safeCardIdx < b.end;
                  return (
                    <button
                      key={b.label}
                      type="button"
                      onClick={() => {
                        setFlipped(false);
                        setCardIndex(b.start);
                      }}
                      className={`border px-2 py-0.5 font-mono text-[9px] uppercase ${
                        activeBatch
                          ? "border-ink bg-ink font-bold text-card"
                          : "border-border bg-paper text-stone hover:border-ink hover:text-ink"
                      }`}
                    >
                      {b.label}
                    </button>
                  );
                })}
              </div>
            )}

            <p className="mb-3 text-center font-mono text-[10px] text-stone">
              &quot;Espace&quot; ou clic pour retourner · &quot;←/→&quot; ou
              swipe tactile pour naviguer
            </p>

            {/* Interactive Flashcard with Mobile Horizontal Swipe */}
            <div
              role="button"
              tabIndex={0}
              onClick={() => setFlipped((p) => !p)}
              onTouchStart={(e) =>
                setCardTouchStartX(e.changedTouches[0]?.clientX ?? null)
              }
              onTouchEnd={(e) => {
                if (cardTouchStartX === null) return;
                const dx =
                  (e.changedTouches[0]?.clientX ?? cardTouchStartX) -
                  cardTouchStartX;
                setCardTouchStartX(null);
                if (Math.abs(dx) > 55) {
                  if (dx < 0) {
                    handleNextCard();
                  } else {
                    handlePrevCard();
                  }
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  setFlipped((p) => !p);
                }
              }}
              className={`mx-auto flex w-full max-w-xl cursor-pointer flex-col justify-between border border-ink p-5 text-left transition-colors focus:outline-none ${
                compact ? "min-h-[180px]" : "min-h-[240px]"
              } ${flipped ? "bg-pinned" : "bg-paper"}`}
            >
              <div className="flex items-center justify-between gap-2 font-mono text-[10px] text-stone">
                <span className="font-bold text-ink">
                  {safeCardIdx + 1}/{visibleCards.length}
                </span>
                <span className="uppercase">
                  {currentCard.tag} · {currentCard.fileName} (P.
                  {currentCard.pageNumber})
                </span>
              </div>

              <div className="my-5 flex flex-1 items-center justify-center text-center">
                <p
                  className={`leading-relaxed text-ink ${
                    flipped
                      ? "text-sm font-medium sm:text-base"
                      : "text-base font-bold sm:text-xl"
                  }`}
                >
                  {flipped
                    ? renderFormattedText(currentCard.back)
                    : currentCard.front}
                </p>
              </div>

              <div className="flex items-center justify-between font-mono text-[11px] text-stone">
                <span>
                  {srsByCardKey[buildFlashcardKey(currentCard.front)]
                    ?.nextReviewDate
                    ? `SRS : ${
                        srsByCardKey[buildFlashcardKey(currentCard.front)]
                          .nextReviewDate
                      }`
                    : "NOUVELLE"}
                </span>
                <span>
                  {flipped ? "Afficher la question" : "Afficher la réponse"}
                </span>
              </div>
            </div>

            {/* Mobile-Friendly SM-2 Control Bar */}
            <div className="mx-auto mt-4 max-w-xl space-y-2.5">
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <button
                  type="button"
                  onClick={() => gradeCard("AGAIN", false)}
                  className="inline-flex min-h-[42px] items-center justify-center gap-1 border border-carmine/50 bg-carmine/10 px-2 font-mono text-[10px] font-bold uppercase text-carmine hover:bg-carmine hover:text-card"
                >
                  <X className="h-3.5 w-3.5" />
                  <span>À REVOIR ({reviewCount})</span>
                </button>
                <button
                  type="button"
                  onClick={() => gradeCard("HARD", false)}
                  className="inline-flex min-h-[42px] items-center justify-center border border-amber/60 bg-amber/15 px-2 font-mono text-[10px] font-bold uppercase text-ink hover:bg-amber hover:text-card"
                >
                  DIFFICILE (1J)
                </button>
                <button
                  type="button"
                  onClick={() => gradeCard("GOOD", true)}
                  className="inline-flex min-h-[42px] items-center justify-center border border-badge-text/50 bg-badge-bg px-2 font-mono text-[10px] font-bold uppercase text-badge-text hover:bg-badge-text hover:text-card"
                >
                  BIEN (3J+)
                </button>
                <button
                  type="button"
                  onClick={() => gradeCard("EASY", true)}
                  className="inline-flex min-h-[42px] items-center justify-center gap-1 border border-forest/50 bg-forest/10 px-2 font-mono text-[10px] font-bold uppercase text-forest hover:bg-forest hover:text-card"
                >
                  <Check className="h-3.5 w-3.5" />
                  <span>FACILE ({masteredCount})</span>
                </button>
              </div>

              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={handlePrevCard}
                  disabled={safeCardIdx === 0}
                  aria-label="Carte précédente"
                  className="inline-flex min-h-[40px] flex-1 items-center justify-center gap-1.5 border border-border bg-paper px-3 font-mono text-[10px] uppercase text-ink hover:border-ink disabled:opacity-35"
                >
                  <ArrowLeft className="h-4 w-4" />
                  <span>PRÉCÉDENTE</span>
                </button>
                <button
                  type="button"
                  onClick={handleNextCard}
                  disabled={safeCardIdx >= visibleCards.length - 1}
                  aria-label="Carte suivante"
                  className="inline-flex min-h-[40px] flex-1 items-center justify-center gap-1.5 border border-ink bg-ink px-3 font-mono text-[10px] uppercase text-card hover:bg-ink/90 disabled:opacity-35"
                >
                  <span>SUIVANTE</span>
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {renderReportBlock(
          `Flashcard #${safeCardIdx + 1} : ${currentCard.front.slice(0, 70)}`
        )}
      </div>
    );
  }

  if (content.kind === "QUIZ") {
    const questions = content.questions || [];
    const checkCorrect = (q: RevisionQuestion): boolean =>
      isRevisionQuestionCorrect(q, quizAnswers[q.id]);

    const score = quizSubmitted
      ? questions.filter((q) => checkCorrect(q)).length
      : 0;
    const answeredCount = questions.filter((q) => {
      const a = quizAnswers[q.id];
      return Array.isArray(a)
        ? a.length > 0
        : typeof a === "string" && a.trim().length > 0;
    }).length;

    const handleSubmitStudioQuiz = () => {
      setQuizSubmitted(true);
      const missed = questions.filter((q) => !checkCorrect(q));
      if (missed.length > 0) {
        void fetch("/api/revisions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "RECORD_MISSED",
            missedQuestions: missed,
          }),
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((d: { recorded?: number } | null) => {
            if (d && typeof d.recorded === "number" && d.recorded > 0) {
              setMissedRecordedCount(d.recorded);
            }
          })
          .catch(() => null);
      } else {
        setMissedRecordedCount(0);
      }
    };

    const editingQuestionsDraft =
      isEditing && editDraft?.kind === "QUIZ" ? editDraft.questions : null;

    return (
      <div className="border border-ink bg-card">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-paper px-3.5 py-2.5 font-mono text-[10px] uppercase tracking-wider">
          <span className="font-bold text-ink">
            QUIZ STUDIO ({questions.length} QUESTIONS)
          </span>
          <div className="flex flex-wrap items-center gap-2">
            {!quizSubmitted && !isEditing && (
              <span className="text-stone">
                RÉPONDUES : {answeredCount} / {questions.length}
              </span>
            )}
            {quizSubmitted && !isEditing && (
              <span className="bg-badge-bg px-2 py-0.5 font-bold text-badge-text">
                SCORE : {score} / {questions.length}
              </span>
            )}
            {canEdit && artifactId && (
              <button
                type="button"
                onClick={() =>
                  isEditing ? setIsEditing(false) : startInlineEdit()
                }
                className={`inline-flex items-center gap-1 border px-2 py-0.5 text-[9px] font-bold ${
                  isEditing
                    ? "border-carmine bg-carmine text-card"
                    : "border-ink bg-card text-ink hover:bg-pinned"
                }`}
              >
                <Pencil className="h-2.5 w-2.5" />
                <span>{isEditing ? "QUITTER ÉDITION" : "ÉDITER"}</span>
              </button>
            )}
          </div>
        </div>

        {isEditing && editingQuestionsDraft ? (
          <div className="space-y-4 p-4">
            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                TITRE DU QUIZ
              </label>
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                className="w-full border border-border bg-paper px-3 py-1.5 text-sm font-bold text-ink"
              />
            </div>

            <div className="max-h-[480px] space-y-3 overflow-y-auto pr-1">
              {editingQuestionsDraft.map((eq, qIdx) => (
                <div
                  key={eq.id || qIdx}
                  className="space-y-2 border border-border bg-paper p-3"
                >
                  <div className="flex items-center justify-between font-mono text-[10px] uppercase text-stone">
                    <span>
                      Q{qIdx + 1} · {eq.type} · P.{eq.pageNumber}
                    </span>
                    <button
                      type="button"
                      disabled={editingQuestionsDraft.length <= 1}
                      onClick={() =>
                        setEditDraft({
                          kind: "QUIZ",
                          sources: content.sources,
                          questions: editingQuestionsDraft.filter(
                            (_, i) => i !== qIdx
                          ),
                        })
                      }
                      className="text-carmine hover:underline disabled:opacity-40"
                    >
                      SUPPRIMER
                    </button>
                  </div>
                  <input
                    type="text"
                    value={eq.prompt}
                    onChange={(e) => {
                      const next = editingQuestionsDraft.map((item, i) =>
                        i === qIdx ? { ...item, prompt: e.target.value } : item
                      );
                      setEditDraft({
                        kind: "QUIZ",
                        sources: content.sources,
                        questions: next,
                      });
                    }}
                    className="w-full border border-border bg-card px-2.5 py-1.5 text-xs font-semibold text-ink"
                  />
                  {(eq.type === "QCU" || eq.type === "QCM") && eq.options && (
                    <div className="space-y-1">
                      {eq.options.map((opt, oIdx) => {
                        const checked = (eq.correctIndices || []).includes(
                          oIdx
                        );
                        return (
                          <div key={oIdx} className="flex items-center gap-2">
                            <input
                              type={eq.type === "QCU" ? "radio" : "checkbox"}
                              checked={checked}
                              onChange={() => {
                                const cur = eq.correctIndices || [];
                                const nextIdx =
                                  eq.type === "QCU"
                                    ? [oIdx]
                                    : checked
                                    ? cur.filter((x) => x !== oIdx)
                                    : [...cur, oIdx].sort((a, b) => a - b);
                                const next = editingQuestionsDraft.map(
                                  (item, i) =>
                                    i === qIdx
                                      ? { ...item, correctIndices: nextIdx }
                                      : item
                                );
                                setEditDraft({
                                  kind: "QUIZ",
                                  sources: content.sources,
                                  questions: next,
                                });
                              }}
                            />
                            <input
                              type="text"
                              value={opt}
                              onChange={(e) => {
                                const nextOpts = eq.options!.map((o, oi) =>
                                  oi === oIdx ? e.target.value : o
                                );
                                const next = editingQuestionsDraft.map(
                                  (item, i) =>
                                    i === qIdx
                                      ? { ...item, options: nextOpts }
                                      : item
                                );
                                setEditDraft({
                                  kind: "QUIZ",
                                  sources: content.sources,
                                  questions: next,
                                });
                              }}
                              className="flex-1 border border-border bg-card px-2 py-1 text-xs text-ink"
                            />
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {(eq.type === "QROC" || eq.type === "FILL_BLANK") && (
                    <input
                      type="text"
                      value={eq.correctAnswer || ""}
                      onChange={(e) => {
                        const next = editingQuestionsDraft.map((item, i) =>
                          i === qIdx
                            ? { ...item, correctAnswer: e.target.value }
                            : item
                        );
                        setEditDraft({
                          kind: "QUIZ",
                          sources: content.sources,
                          questions: next,
                        });
                      }}
                      placeholder="Réponse exacte attendue"
                      className="w-full border border-border bg-card px-2.5 py-1 text-xs text-ink"
                    />
                  )}
                  <textarea
                    rows={2}
                    value={eq.explanation}
                    onChange={(e) => {
                      const next = editingQuestionsDraft.map((item, i) =>
                        i === qIdx
                          ? { ...item, explanation: e.target.value }
                          : item
                      );
                      setEditDraft({
                        kind: "QUIZ",
                        sources: content.sources,
                        questions: next,
                      });
                    }}
                    placeholder="Explication pédagogique"
                    className="w-full border border-border bg-card px-2.5 py-1 text-xs text-stone"
                  />
                </div>
              ))}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
              <button
                type="button"
                onClick={() => setIsEditing(false)}
                className="border border-border bg-paper px-3 py-1.5 font-mono text-[10px] uppercase text-stone"
              >
                ANNULER
              </button>
              <button
                type="button"
                disabled={savingEdit}
                onClick={() => void saveInlineEdit()}
                className="inline-flex items-center gap-1.5 border border-ink bg-ink px-4 py-1.5 font-mono text-[10px] font-semibold uppercase text-card disabled:opacity-50"
              >
                <Save className="h-3 w-3" />
                <span>ENREGISTRER LES MODIFICATIONS</span>
              </button>
            </div>
          </div>
        ) : (
        <div className="space-y-4 p-4">
          {questions.map((q, idx) => {
            const isOk = quizSubmitted ? checkCorrect(q) : undefined;
            return (
              <div
                key={q.id}
                className={`border p-3.5 ${
                  quizSubmitted && isOk === true
                    ? "border-forest bg-forest/5"
                    : quizSubmitted && isOk === false
                    ? "border-carmine bg-carmine/5"
                    : "border-border bg-paper"
                }`}
              >
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-wider text-stone">
                  <span>
                    QUESTION {idx + 1} · {q.type}
                  </span>
                  <span>
                    {q.fileName} (P.{q.pageNumber})
                  </span>
                </div>

                <p className="mb-3 text-sm font-semibold leading-snug text-ink">
                  {q.prompt}
                </p>

                {(q.type === "QCU" || q.type === "QCM") && q.options && (
                  <div className="space-y-2">
                    {q.options.map((opt, optIdx) => {
                      const sel = Array.isArray(quizAnswers[q.id])
                        ? (quizAnswers[q.id] as number[])
                        : [];
                      const active = sel.includes(optIdx);
                      const expected = q.correctIndices?.includes(optIdx);
                      const letter = OPTION_LETTERS[optIdx] || String(optIdx + 1);

                      return (
                        <button
                          key={optIdx}
                          type="button"
                          disabled={quizSubmitted}
                          onClick={() => {
                            if (q.type === "QCU") {
                              setQuizAnswers((p) => ({
                                ...p,
                                [q.id]: [optIdx],
                              }));
                            } else {
                              const next = active
                                ? sel.filter((i) => i !== optIdx)
                                : [...sel, optIdx];
                              setQuizAnswers((p) => ({ ...p, [q.id]: next }));
                            }
                          }}
                          className={`flex w-full items-center gap-3 border px-3 py-2.5 text-left text-xs transition-colors ${
                            quizSubmitted && expected
                              ? "border-forest bg-forest/10 font-semibold text-ink"
                              : quizSubmitted && active && !expected
                              ? "border-carmine bg-carmine/10 text-carmine"
                              : active
                              ? "border-ink bg-pinned font-semibold text-ink"
                              : "border-border bg-card text-ink hover:border-ink/60"
                          }`}
                        >
                          <span
                            className={`inline-flex h-5 w-5 shrink-0 items-center justify-center border font-mono text-[10px] font-bold ${
                              active
                                ? "border-ink bg-ink text-card"
                                : "border-border bg-paper text-stone"
                            }`}
                          >
                            {letter}
                          </span>
                          <span className="flex-1">{opt}</span>
                        </button>
                      );
                    })}
                  </div>
                )}

                {q.type === "QROC" && (
                  <div className="space-y-2">
                    <textarea
                      rows={2}
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
                      placeholder="Votre réponse courte (1 à 5 mots clés)..."
                      className="w-full border border-border bg-card px-2.5 py-2 text-xs text-ink focus:border-ink focus:outline-none"
                    />
                    {quizSubmitted && q.correctAnswer && (
                      <div className="border border-forest/40 bg-forest/10 p-2 text-[11px] text-ink">
                        <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-forest">
                          RÉPONSE ATTENDUE : {q.correctAnswer}
                        </p>
                        {q.acceptedKeywords && q.acceptedKeywords.length > 1 && (
                          <p className="mt-0.5 font-mono text-[9px] uppercase tracking-wider text-stone">
                            MOTS-CLÉS : {q.acceptedKeywords.join(" · ")}
                          </p>
                        )}
                      </div>
                    )}
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
                  <p className="mt-2.5 border-t border-border pt-2 text-xs text-stone">
                    {renderFormattedText(q.explanation)}
                  </p>
                )}
              </div>
            );
          })}

          {quizSubmitted && missedRecordedCount !== null && missedRecordedCount > 0 && (
            <div className="border border-amber/50 bg-amber/10 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-ink">
              {missedRecordedCount} question
              {missedRecordedCount > 1 ? "s" : ""} ratée
              {missedRecordedCount > 1 ? "s" : ""} enregistrée
              {missedRecordedCount > 1 ? "s" : ""} automatiquement dans votre
              Carnet d&apos;erreurs SRS (/revisions).
            </div>
          )}

          <div className="flex justify-end gap-2">
            {quizSubmitted ? (
              <button
                type="button"
                onClick={() => {
                  setQuizAnswers({});
                  setQuizSubmitted(false);
                  setMissedRecordedCount(null);
                }}
                className="border border-border bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink"
              >
                RECOMMENCER
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmitStudioQuiz}
                className="border border-ink bg-ink px-4 py-2 font-mono text-[11px] font-semibold uppercase tracking-wider text-card hover:bg-ink/90"
              >
                CORRIGER LE QUIZ
              </button>
            )}
          </div>
        </div>
        )}

        {renderReportBlock(`Quiz : ${title.slice(0, 70)}`)}
      </div>
    );
  }

  // SUMMARY ("Fiche de Révision Ultime" modeled after attached 7-page PDF)
  const editingSummaryDraft =
    isEditing && editDraft?.kind === "SUMMARY" ? editDraft : null;

  return (
    <div
      className="border border-ink bg-card"
      style={{ borderTop: "3px solid #3D6B99" }}
    >
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-paper px-4 py-3">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
            ARA STUDIO · FICHE DE RÉVISION ULTIME
          </p>
          <h3 className="text-base font-bold tracking-tight text-ink">
            {title}
          </h3>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={() =>
              downloadFileWithSlug(
                buildSummaryMarkdownExport(title, content),
                "md",
                "text/markdown;charset=utf-8"
              )
            }
            className="inline-flex items-center gap-1.5 border border-border bg-card px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink hover:border-ink"
          >
            <Download className="h-3.5 w-3.5" />
            <span>EXPORT .MD</span>
          </button>
          <button
            type="button"
            onClick={() => handlePrintSummaryPdf(content)}
            className="inline-flex items-center gap-1.5 border border-ink bg-card px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink hover:bg-pinned"
          >
            <Printer className="h-3.5 w-3.5" />
            <span>IMPRIMER / PDF</span>
          </button>
          {canEdit && artifactId && (
            <button
              type="button"
              onClick={() =>
                isEditing ? setIsEditing(false) : startInlineEdit()
              }
              className={`inline-flex items-center gap-1 border px-2.5 py-1.5 font-mono text-[10px] font-bold uppercase tracking-wider ${
                isEditing
                  ? "border-carmine bg-carmine text-card"
                  : "border-ink bg-ink text-card hover:bg-ink/90"
              }`}
            >
              <Pencil className="h-3 w-3" />
              <span>{isEditing ? "QUITTER ÉDITION" : "ÉDITER"}</span>
            </button>
          )}
        </div>
      </div>

      {isEditing && editingSummaryDraft ? (
        <div className="space-y-4 p-4 sm:p-6">
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
              TITRE DE LA FICHE
            </label>
            <input
              type="text"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              className="w-full border border-border bg-paper px-3 py-2 text-sm font-bold text-ink"
            />
          </div>

          <div className="space-y-4">
            {(editingSummaryDraft.sections || []).map((sec, sIdx) => (
              <div
                key={sIdx}
                className="space-y-3 border border-border bg-paper p-3.5"
              >
                <div className="flex items-center gap-2">
                  <span className="font-mono text-xs font-bold text-stone">
                    {sIdx + 1}.
                  </span>
                  <input
                    type="text"
                    value={sec.title}
                    onChange={(e) => {
                      const nextSecs = (editingSummaryDraft.sections || []).map(
                        (s, i) => (i === sIdx ? { ...s, title: e.target.value } : s)
                      );
                      setEditDraft({
                        ...editingSummaryDraft,
                        sections: nextSecs,
                      });
                    }}
                    className="flex-1 border border-border bg-card px-2.5 py-1 text-xs font-bold text-ink"
                  />
                </div>

                {(sec.subsections || []).map((sub, subIdx) => (
                  <div
                    key={subIdx}
                    className="space-y-2 border-l-2 border-border pl-3"
                  >
                    <input
                      type="text"
                      value={sub.title}
                      onChange={(e) => {
                        const nextSubs = (sec.subsections || []).map((sb, i) =>
                          i === subIdx ? { ...sb, title: e.target.value } : sb
                        );
                        const nextSecs = (editingSummaryDraft.sections || []).map(
                          (s, i) =>
                            i === sIdx ? { ...s, subsections: nextSubs } : s
                        );
                        setEditDraft({
                          ...editingSummaryDraft,
                          sections: nextSecs,
                        });
                      }}
                      className="w-full border border-border bg-card px-2 py-1 text-xs font-semibold text-ink"
                    />
                    {(sub.bullets || []).map((b, bIdx) => (
                      <div key={bIdx} className="flex items-start gap-1.5">
                        <input
                          type="text"
                          value={b.lead || ""}
                          onChange={(e) => {
                            const nextBullets = (sub.bullets || []).map(
                              (bl, i) =>
                                i === bIdx ? { ...bl, lead: e.target.value } : bl
                            );
                            const nextSubs = (sec.subsections || []).map(
                              (sb, i) =>
                                i === subIdx
                                  ? { ...sb, bullets: nextBullets }
                                  : sb
                            );
                            const nextSecs = (
                              editingSummaryDraft.sections || []
                            ).map((s, i) =>
                              i === sIdx ? { ...s, subsections: nextSubs } : s
                            );
                            setEditDraft({
                              ...editingSummaryDraft,
                              sections: nextSecs,
                            });
                          }}
                          placeholder="Concept"
                          className="w-36 shrink-0 border border-border bg-card px-2 py-1 text-xs font-semibold text-ink"
                        />
                        <textarea
                          rows={2}
                          value={b.text}
                          onChange={(e) => {
                            const nextBullets = (sub.bullets || []).map(
                              (bl, i) =>
                                i === bIdx ? { ...bl, text: e.target.value } : bl
                            );
                            const nextSubs = (sec.subsections || []).map(
                              (sb, i) =>
                                i === subIdx
                                  ? { ...sb, bullets: nextBullets }
                                  : sb
                            );
                            const nextSecs = (
                              editingSummaryDraft.sections || []
                            ).map((s, i) =>
                              i === sIdx ? { ...s, subsections: nextSubs } : s
                            );
                            setEditDraft({
                              ...editingSummaryDraft,
                              sections: nextSecs,
                            });
                          }}
                          className="flex-1 border border-border bg-card px-2 py-1 text-xs text-ink"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            const nextBullets = (sub.bullets || []).filter(
                              (_, i) => i !== bIdx
                            );
                            const nextSubs = (sec.subsections || []).map(
                              (sb, i) =>
                                i === subIdx
                                  ? { ...sb, bullets: nextBullets }
                                  : sb
                            );
                            const nextSecs = (
                              editingSummaryDraft.sections || []
                            ).map((s, i) =>
                              i === sIdx ? { ...s, subsections: nextSubs } : s
                            );
                            setEditDraft({
                              ...editingSummaryDraft,
                              sections: nextSecs,
                            });
                          }}
                          className="border border-border bg-card p-1.5 text-carmine hover:bg-carmine/10"
                          title="Supprimer cette puce"
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      onClick={() => {
                        const nextBullets = [
                          ...(sub.bullets || []),
                          { lead: "Notion", text: "" },
                        ];
                        const nextSubs = (sec.subsections || []).map((sb, i) =>
                          i === subIdx ? { ...sb, bullets: nextBullets } : sb
                        );
                        const nextSecs = (editingSummaryDraft.sections || []).map(
                          (s, i) =>
                            i === sIdx ? { ...s, subsections: nextSubs } : s
                        );
                        setEditDraft({
                          ...editingSummaryDraft,
                          sections: nextSecs,
                        });
                      }}
                      className="inline-flex items-center gap-1 font-mono text-[9px] uppercase text-badge-text hover:underline"
                    >
                      <Plus className="h-3 w-3" />
                      <span>AJOUTER UNE PUCE</span>
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="space-y-2 border border-border bg-paper p-3.5">
            <p className="font-mono text-[10px] font-bold uppercase text-ink">
              POINTS DE VIGILANCE PARTIELS
            </p>
            {(editingSummaryDraft.examPitfalls || []).map((pf, pIdx) => (
              <div key={pIdx} className="flex items-center gap-1.5">
                <input
                  type="text"
                  value={pf}
                  onChange={(e) => {
                    const nextPf = editingSummaryDraft.examPitfalls.map(
                      (x, i) => (i === pIdx ? e.target.value : x)
                    );
                    setEditDraft({
                      ...editingSummaryDraft,
                      examPitfalls: nextPf,
                    });
                  }}
                  className="flex-1 border border-border bg-card px-2 py-1 text-xs text-ink"
                />
                <button
                  type="button"
                  onClick={() => {
                    setEditDraft({
                      ...editingSummaryDraft,
                      examPitfalls: editingSummaryDraft.examPitfalls.filter(
                        (_, i) => i !== pIdx
                      ),
                    });
                  }}
                  className="border border-border bg-card p-1 text-carmine"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setEditDraft({
                  ...editingSummaryDraft,
                  examPitfalls: [
                    ...(editingSummaryDraft.examPitfalls || []),
                    "",
                  ],
                })
              }
              className="inline-flex items-center gap-1 font-mono text-[9px] uppercase text-badge-text hover:underline"
            >
              <Plus className="h-3 w-3" />
              <span>AJOUTER UN PIÈGE</span>
            </button>
          </div>

          <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
            <button
              type="button"
              onClick={() => setIsEditing(false)}
              className="border border-border bg-paper px-3 py-1.5 font-mono text-[10px] uppercase text-stone"
            >
              ANNULER
            </button>
            <button
              type="button"
              disabled={savingEdit}
              onClick={() => void saveInlineEdit()}
              className="inline-flex items-center gap-1.5 border border-ink bg-ink px-4 py-1.5 font-mono text-[10px] font-semibold uppercase text-card disabled:opacity-50"
            >
              <Save className="h-3 w-3" />
              <span>ENREGISTRER LES MODIFICATIONS</span>
            </button>
          </div>
        </div>
      ) : (
      <div className="space-y-5 p-4 sm:p-6">
        {content.overview &&
          !content.overview.trim().startsWith("[") &&
          content.overview.length <= 420 && (
            <p className="text-xs leading-relaxed text-stone">
              {renderFormattedText(content.overview)}
            </p>
          )}

        {content.sections && content.sections.length > 0 && (
          <div className="space-y-6">
            {content.sections.map((sec, idx) => (
              <section
                key={`${sec.title}-${idx}`}
                className={
                  idx > 0 ? "border-t border-dashed border-border pt-5" : ""
                }
              >
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
                  <h4 className="text-sm font-bold tracking-tight text-ink sm:text-base">
                    {idx + 1}. {sec.title}
                  </h4>
                  <span className="bg-badge-bg px-2 py-0.5 font-mono text-[9px] font-semibold uppercase text-badge-text">
                    {sec.pageRange}
                  </span>
                </div>

                {sec.subsections && sec.subsections.length > 0 ? (
                  <div className="space-y-4">
                    {sec.subsections.map((sub, subIdx) => (
                      <div key={`${sub.title}-${subIdx}`} className="space-y-2.5">
                        <h5 className="flex items-center gap-1.5 text-xs font-bold tracking-tight text-[#3D6B99] sm:text-sm">
                          <span>{sub.icon || "📌"}</span>
                          <span>{sub.title}</span>
                        </h5>

                        {sub.intro && (
                          <p className="text-xs leading-relaxed text-ink">
                            {renderFormattedText(sub.intro)}
                          </p>
                        )}

                        {sub.callouts &&
                          sub.callouts.map((c, cIdx) => (
                            <div
                              key={cIdx}
                              className="border border-amber/40 bg-[#FEF9E7] px-3.5 py-2.5 text-xs text-ink"
                              style={{ borderLeft: "3px solid #D99B26" }}
                            >
                              <p className="mb-1 font-bold text-ink">
                                {c.icon || "💡"} {c.title} :
                              </p>
                              {c.text && (
                                <p className="leading-relaxed">
                                  {renderFormattedText(c.text)}
                                </p>
                              )}
                              {c.items && c.items.length > 0 && (
                                <ol className="mt-1 list-decimal space-y-1 pl-4">
                                  {c.items.map((it, itIdx) => (
                                    <li key={itIdx} className="leading-relaxed">
                                      {renderFormattedText(it)}
                                    </li>
                                  ))}
                                </ol>
                              )}
                            </div>
                          ))}

                        {sub.bullets && sub.bullets.length > 0 && (
                          <ul className="list-disc space-y-1.5 pl-5 text-xs text-ink">
                            {sub.bullets.map((b, bIdx) => (
                              <li key={bIdx} className="leading-relaxed">
                                {b.lead && (
                                  <strong className="font-bold text-ink">
                                    {b.lead} :{" "}
                                  </strong>
                                )}
                                <span>{renderFormattedText(b.text)}</span>
                                {b.subItems && b.subItems.length > 0 && (
                                  <ul className="mt-1 [list-style-type:circle] space-y-0.5 pl-4 text-stone">
                                    {b.subItems.map((si, siIdx) => (
                                      <li key={siIdx}>
                                        {renderFormattedText(si)}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </li>
                            ))}
                          </ul>
                        )}

                        {sub.table &&
                          sub.table.headers.length > 0 &&
                          sub.table.rows.length > 0 && (
                            <div className="overflow-x-auto border border-border">
                              {sub.table.title && (
                                <div className="border-b border-border bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink">
                                  {sub.table.title}
                                </div>
                              )}
                              <table className="w-full border-collapse text-left text-xs">
                                <thead>
                                  <tr className="border-b border-border bg-paper font-bold text-ink">
                                    {sub.table.headers.map((h, hIdx) => (
                                      <th key={hIdx} className="px-3 py-2">
                                        {h}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody className="divide-y divide-border bg-card">
                                  {sub.table.rows.map((row, rIdx) => (
                                    <tr key={rIdx}>
                                      {row.map((cell, cellIdx) => (
                                        <td
                                          key={cellIdx}
                                          className={`px-3 py-2 ${
                                            cellIdx === 0
                                              ? "font-semibold text-ink"
                                              : "text-stone"
                                          }`}
                                        >
                                          {renderFormattedText(cell)}
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="space-y-2">
                    <p className="text-xs leading-relaxed text-ink">
                      {renderFormattedText(sec.content)}
                    </p>
                    {sec.keyPoints && sec.keyPoints.length > 0 && (
                      <ul className="list-disc space-y-1 pl-4 text-xs text-ink">
                        {sec.keyPoints.map((kp, kIdx) => (
                          <li key={kIdx}>{renderFormattedText(kp)}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}
              </section>
            ))}
          </div>
        )}

        {content.keyConcepts.length > 0 && (
          <div className="space-y-1.5 border-t border-dashed border-border pt-4">
            <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-stone">
              INDEX DES NOTIONS CLÉS :
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
                  <p className="mt-1 text-xs text-stone">
                    {renderFormattedText(kc.definition)}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}

        {content.examPitfalls.length > 0 && (
          <div
            className="border border-amber/40 bg-[#FEF9E7] p-3.5"
            style={{ borderLeft: "3px solid #D99B26" }}
          >
            <p className="mb-1.5 font-mono text-[10px] font-bold uppercase tracking-wider text-ink">
              ⚠️ POINTS DE VIGILANCE PARTIELS :
            </p>
            <ul className="list-disc space-y-1 pl-4 text-xs text-ink">
              {content.examPitfalls.map((p, idx) => (
                <li key={idx}>{renderFormattedText(p)}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      )}

      {renderReportBlock(`Fiche : ${title.slice(0, 70)}`)}
    </div>
  );
}
