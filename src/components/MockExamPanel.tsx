"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Clock,
  FileText,
  History,
  Loader2,
  Play,
  Send,
  Timer,
  XCircle,
} from "lucide-react";
import type {
  ImagePointAnswer,
  RevisionAnswerValue,
  RevisionQuestion,
} from "@/lib/revisions";

const ImagePointCanvas = dynamic(
  () =>
    import("@/components/ImagePointCanvas").then(
      (mod) => mod.ImagePointCanvas
    ),
  { ssr: false }
);

interface ChapterBreakdownItem {
  chapterTitle: string;
  correct: number;
  total: number;
  percent: number;
}

interface MockExamHistoryItem {
  id: string;
  durationMinutes: number;
  score: number;
  totalQuestions: number;
  grade20: number;
  chapterBreakdown: ChapterBreakdownItem[];
  completedAt: string;
}

interface ActiveExam {
  id: string;
  ueId: string;
  durationMinutes: number;
  questions: RevisionQuestion[];
  totalQuestions: number;
}

interface GradedExamResult {
  id: string;
  score: number;
  totalQuestions: number;
  grade20: number;
  results: Record<string, boolean>;
  chapterBreakdown: ChapterBreakdownItem[];
  missedAddedCount: number;
  questions: RevisionQuestion[];
  answers: Record<string, RevisionAnswerValue>;
}

interface MockExamPanelProps {
  ueId: string;
  ueCode: string;
  ueTitle: string;
  hasDocuments: boolean;
  onOpenDocumentPage?: (documentId: string, pageNumber: number) => void;
}

function formatTimer(seconds: number): string {
  const m = Math.floor(Math.max(0, seconds) / 60);
  const s = Math.max(0, seconds) % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function MockExamPanel({
  ueId,
  ueCode,
  ueTitle,
  hasDocuments,
  onOpenDocumentPage,
}: MockExamPanelProps) {
  const [questionCount, setQuestionCount] = useState<number>(8);
  const [durationMinutes, setDurationMinutes] = useState<number>(20);
  const [history, setHistory] = useState<MockExamHistoryItem[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [activeExam, setActiveExam] = useState<ActiveExam | null>(null);
  const [answers, setAnswers] = useState<Record<string, RevisionAnswerValue>>(
    {}
  );
  const [secondsLeft, setSecondsLeft] = useState<number>(0);
  const [result, setResult] = useState<GradedExamResult | null>(null);

  const answersRef = useRef(answers);
  answersRef.current = answers;
  const activeExamRef = useRef(activeExam);
  activeExamRef.current = activeExam;

  const loadHistory = useCallback(async () => {
    try {
      const res = await fetch(`/api/exams?ueId=${encodeURIComponent(ueId)}`, {
        cache: "no-store",
      });
      if (res.ok) {
        const data = (await res.json()) as { history?: MockExamHistoryItem[] };
        setHistory(data.history || []);
      }
    } finally {
      setLoadingHistory(false);
    }
  }, [ueId]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  const submitExam = useCallback(async () => {
    const exam = activeExamRef.current;
    if (!exam || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/exams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "SUBMIT",
          examId: exam.id,
          answers: answersRef.current,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        result?: GradedExamResult;
        history?: MockExamHistoryItem[];
        error?: string;
      };
      if (!res.ok || !data.result) {
        setError(data.error || "Erreur lors de la correction.");
        return;
      }
      setActiveExam(null);
      setResult(data.result);
      if (data.history) setHistory(data.history);
    } finally {
      setBusy(false);
    }
  }, [busy]);

  // Countdown ticker while exam is running
  useEffect(() => {
    if (!activeExam) return;
    const interval = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          void submitExam();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [activeExam, submitExam]);

  async function handleStartExam() {
    if (busy) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/exams", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "START",
          ueId,
          count: questionCount,
          durationMinutes,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        exam?: ActiveExam;
        error?: string;
      };
      if (!res.ok || !data.exam) {
        setError(data.error || "Impossible de démarrer le partiel blanc.");
        return;
      }
      setAnswers({});
      setSecondsLeft(data.exam.durationMinutes * 60);
      setActiveExam(data.exam);
    } finally {
      setBusy(false);
    }
  }

  const averageGrade20 =
    history.length > 0
      ? (
          history.reduce((sum, h) => sum + h.grade20, 0) / history.length
        ).toFixed(1)
      : null;

  return (
    <div className="space-y-6">
      {/* Header Banner */}
      <div
        className="flex flex-wrap items-center justify-between gap-4 border border-border bg-card p-5"
        style={{ borderTop: "3px solid #C83E4D" }}
      >
        <div>
          <p className="font-mono text-[10px] font-semibold uppercase tracking-wider text-stone">
            CONDITIONS D&apos;EXAMEN RÉELLES · CHRONOMÈTRE &amp; CORRECTION /20
          </p>
          <h2 className="mt-1 flex items-center gap-2 text-base font-bold uppercase tracking-tight text-ink">
            <Timer className="h-4 w-4 text-carmine" />
            <span>
              PARTIEL BLANC · {ueCode} — {ueTitle}
            </span>
          </h2>
        </div>

        {activeExam ? (
          <div
            className={`flex items-center gap-2 border px-4 py-2 font-mono text-base font-bold ${
              secondsLeft <= 60
                ? "border-carmine bg-carmine text-card"
                : "border-ink bg-ink text-card"
            }`}
          >
            <Clock className="h-4 w-4" />
            <span>{formatTimer(secondsLeft)}</span>
          </div>
        ) : (
          averageGrade20 !== null && (
            <div className="border border-border bg-paper px-4 py-2 text-right">
              <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                MOYENNE HISTORIQUE
              </p>
              <p className="font-mono text-base font-bold text-ink">
                {averageGrade20} / 20
              </p>
            </div>
          )
        )}
      </div>

      {error && (
        <div className="border border-carmine/40 bg-carmine/10 px-4 py-2.5 font-mono text-xs text-carmine">
          {error}
        </div>
      )}

      {/* VIEW 1: Active Timed Exam */}
      {activeExam && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2 border border-border bg-paper px-4 py-2.5 font-mono text-[11px] uppercase tracking-wider text-stone">
            <span>
              ÉPREUVE EN COURS · {activeExam.questions.length} QUESTIONS · AUCUNE
              CORRECTION AVANT REMISE DE COPIE
            </span>
            <span>
              RÉPONDUES : {Object.keys(answers).length} /{" "}
              {activeExam.questions.length}
            </span>
          </div>

          {activeExam.questions.map((q, qIdx) => (
            <article
              key={q.id}
              className="border border-border bg-card p-5"
            >
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
                <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
                  <span className="bg-ink px-2 py-0.5 font-bold text-card">
                    Q{qIdx + 1}
                  </span>
                  <span className="bg-badge-bg px-2 py-0.5 font-semibold text-badge-text">
                    {q.type}
                  </span>
                </div>
                <span className="font-mono text-[10px] uppercase text-stone">
                  {q.chapterTitle}
                </span>
              </div>

              <p className="mb-4 text-sm font-semibold leading-relaxed text-ink">
                {q.prompt}
              </p>

              {(q.type === "QCU" || q.type === "QCM") && q.options && (
                <div className="space-y-2">
                  {q.options.map((opt, optIdx) => {
                    const selectedArr = Array.isArray(answers[q.id])
                      ? (answers[q.id] as number[])
                      : [];
                    const isSelected = selectedArr.includes(optIdx);
                    return (
                      <button
                        key={optIdx}
                        type="button"
                        onClick={() => {
                          if (q.type === "QCU") {
                            setAnswers((p) => ({ ...p, [q.id]: [optIdx] }));
                          } else {
                            const next = isSelected
                              ? selectedArr.filter((i) => i !== optIdx)
                              : [...selectedArr, optIdx];
                            setAnswers((p) => ({ ...p, [q.id]: next }));
                          }
                        }}
                        className={`flex w-full items-start gap-3 border p-3 text-left text-sm ${
                          isSelected
                            ? "border-ink bg-pinned"
                            : "border-border bg-paper hover:border-ink"
                        }`}
                      >
                        <span
                          className={`mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center border font-mono text-[10px] font-bold ${
                            isSelected
                              ? "border-ink bg-ink text-card"
                              : "border-border bg-card text-stone"
                          }`}
                        >
                          {isSelected ? "✓" : String.fromCharCode(65 + optIdx)}
                        </span>
                        <span>{opt}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {q.type === "FILL_BLANK" && (
                <div className="space-y-3">
                  <div className="border border-border bg-paper p-3 text-sm text-ink">
                    {q.sentenceWithBlank}
                  </div>
                  <input
                    type="text"
                    value={
                      typeof answers[q.id] === "string"
                        ? (answers[q.id] as string)
                        : ""
                    }
                    onChange={(e) =>
                      setAnswers((p) => ({ ...p, [q.id]: e.target.value }))
                    }
                    placeholder="Tapez le terme exact..."
                    className="w-full border border-border bg-paper px-3 py-2 font-mono text-xs text-ink focus:border-ink focus:outline-none"
                  />
                  {q.wordBank && q.wordBank.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {q.wordBank.map((term) => (
                        <button
                          key={term}
                          type="button"
                          onClick={() =>
                            setAnswers((p) => ({ ...p, [q.id]: term }))
                          }
                          className={`border px-2.5 py-1 font-mono text-xs ${
                            answers[q.id] === term
                              ? "border-ink bg-ink text-card"
                              : "border-border bg-paper text-ink hover:border-ink"
                          }`}
                        >
                          {term}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {q.type === "IMAGE_POINT" && (
                <ImagePointCanvas
                  documentId={q.documentId}
                  pageNumber={q.pageNumber}
                  targetPhrase={q.targetPhrase}
                  fallbackZones={q.fallbackZones}
                  correctZoneId={q.correctZoneId}
                  value={
                    answers[q.id] &&
                    typeof answers[q.id] === "object" &&
                    !Array.isArray(answers[q.id])
                      ? (answers[q.id] as ImagePointAnswer)
                      : undefined
                  }
                  onChange={(val) =>
                    setAnswers((p) => ({ ...p, [q.id]: val }))
                  }
                />
              )}
            </article>
          ))}

          <div className="flex justify-end border border-border bg-card p-4">
            <button
              type="button"
              disabled={busy}
              onClick={() => void submitExam()}
              className="inline-flex items-center gap-2 border border-ink bg-ink px-6 py-3 font-mono text-xs font-semibold uppercase tracking-wider text-card hover:bg-ink/90 disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
              <span>RENDRE MA COPIE &amp; CORRIGER</span>
            </button>
          </div>
        </div>
      )}

      {/* VIEW 2: Graded Exam Results */}
      {!activeExam && result && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
            <div
              className="border border-ink bg-card p-6 md:col-span-4"
              style={{
                borderTop: `3px solid ${
                  result.grade20 >= 10 ? "#3B7A57" : "#C83E4D"
                }`,
              }}
            >
              <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                NOTE PARTIEL BLANC
              </p>
              <p
                className={`mt-2 font-mono text-4xl font-bold ${
                  result.grade20 >= 10 ? "text-forest" : "text-carmine"
                }`}
              >
                {result.grade20} / 20
              </p>
              <p className="mt-2 font-mono text-xs uppercase tracking-wider text-ink">
                {result.score} / {result.totalQuestions} BONNES RÉPONSES
              </p>
              {result.missedAddedCount > 0 && (
                <p className="mt-3 border border-amber/50 bg-amber/10 px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink">
                  {result.missedAddedCount} ERREUR
                  {result.missedAddedCount > 1 ? "S" : ""} AJOUTÉE
                  {result.missedAddedCount > 1 ? "S" : ""} AU CARNET SRS
                </p>
              )}
            </div>

            {/* Chapter Mastery Breakdown */}
            <div className="border border-border bg-card p-5 md:col-span-8">
              <p className="mb-3 font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                BILAN DE MAÎTRISE PAR CHAPITRE
              </p>
              <div className="space-y-3">
                {result.chapterBreakdown.map((ch) => (
                  <div key={ch.chapterTitle}>
                    <div className="mb-1 flex items-center justify-between font-mono text-[11px] uppercase tracking-wider">
                      <span className="truncate text-ink">
                        {ch.chapterTitle}
                      </span>
                      <span className="font-bold text-ink">
                        {ch.correct}/{ch.total} ({ch.percent}%)
                      </span>
                    </div>
                    <div className="h-2.5 w-full border border-border bg-paper">
                      <div
                        className="h-full"
                        style={{
                          width: `${ch.percent}%`,
                          backgroundColor:
                            ch.percent >= 70
                              ? "#3B7A57"
                              : ch.percent >= 40
                              ? "#D99B26"
                              : "#C83E4D",
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Question-by-question Correction */}
          <div className="space-y-3">
            <h3 className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
              CORRIGÉ DÉTAILLÉ ({result.questions.length} QUESTIONS)
            </h3>

            {result.questions.map((q, idx) => {
              const ok = result.results[q.id];
              return (
                <article
                  key={q.id}
                  className={`border bg-card p-4 ${
                    ok ? "border-forest" : "border-carmine"
                  }`}
                >
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
                      {ok ? (
                        <span className="inline-flex items-center gap-1 bg-forest/15 px-2 py-0.5 font-bold text-forest">
                          <Check className="h-3 w-3" /> Q{idx + 1} · EXACT
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 bg-carmine/15 px-2 py-0.5 font-bold text-carmine">
                          <XCircle className="h-3 w-3" /> Q{idx + 1} · ERREUR
                        </span>
                      )}
                      <span className="text-stone">{q.chapterTitle}</span>
                    </div>

                    {onOpenDocumentPage && (
                      <button
                        type="button"
                        onClick={() =>
                          onOpenDocumentPage(q.documentId, q.pageNumber)
                        }
                        className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-badge-text hover:underline"
                      >
                        <FileText className="h-3 w-3" />
                        <span>
                          {q.fileName} · P.{q.pageNumber}
                        </span>
                      </button>
                    )}
                  </div>

                  <p className="text-sm font-semibold text-ink">{q.prompt}</p>
                  {q.options && q.correctIndices && (
                    <p className="mt-2 font-mono text-xs text-forest">
                      Réponse attendue :{" "}
                      {q.correctIndices
                        .map((i) => q.options?.[i])
                        .filter(Boolean)
                        .join(" · ")}
                    </p>
                  )}
                  {q.correctAnswer && (
                    <p className="mt-2 font-mono text-xs text-forest">
                      Réponse attendue : {q.correctAnswer}
                    </p>
                  )}
                  <p className="mt-1.5 text-xs text-stone">{q.explanation}</p>
                </article>
              );
            })}
          </div>
        </div>
      )}

      {/* VIEW 3: Configuration & History */}
      {!activeExam && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="space-y-4 border border-border bg-card p-5 lg:col-span-5">
            <h3 className="font-mono text-xs font-bold uppercase tracking-wider text-ink">
              PARAMÈTRES DE L&apos;ÉPREUVE
            </h3>

            {!hasDocuments ? (
              <p className="text-xs text-stone">
                Déposez et indexez au moins un polycopié PDF dans cette UE pour
                générer un partiel blanc.
              </p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                      NOMBRE DE QUESTIONS
                    </label>
                    <select
                      value={questionCount}
                      onChange={(e) => setQuestionCount(Number(e.target.value))}
                      className="w-full border border-border bg-paper px-3 py-2 font-mono text-xs uppercase text-ink focus:border-ink focus:outline-none"
                    >
                      <option value={4}>4 QUESTIONS</option>
                      <option value={8}>8 QUESTIONS</option>
                      <option value={12}>12 QUESTIONS</option>
                      <option value={16}>16 QUESTIONS</option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                      CHRONOMÈTRE
                    </label>
                    <select
                      value={durationMinutes}
                      onChange={(e) =>
                        setDurationMinutes(Number(e.target.value))
                      }
                      className="w-full border border-border bg-paper px-3 py-2 font-mono text-xs uppercase text-ink focus:border-ink focus:outline-none"
                    >
                      <option value={10}>10 MINUTES</option>
                      <option value={20}>20 MINUTES</option>
                      <option value={30}>30 MINUTES</option>
                      <option value={45}>45 MINUTES</option>
                    </select>
                  </div>
                </div>

                <button
                  type="button"
                  disabled={busy}
                  onClick={handleStartExam}
                  className="inline-flex w-full items-center justify-center gap-2 border border-ink bg-ink px-4 py-3 font-mono text-xs font-semibold uppercase tracking-wider text-card hover:bg-ink/90 disabled:opacity-50"
                >
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  <span>LANCER UN PARTIEL BLANC ({durationMinutes} MIN)</span>
                </button>
              </>
            )}
          </div>

          <div className="border border-border bg-card lg:col-span-7">
            <div className="flex items-center gap-2 border-b border-border bg-paper px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider text-ink">
              <History className="h-3.5 w-3.5" />
              <span>HISTORIQUE DES COPIES SUR {ueCode} ({history.length})</span>
            </div>

            {loadingHistory ? (
              <div className="p-6 font-mono text-xs uppercase text-stone">
                CHARGEMENT DE L&apos;HISTORIQUE...
              </div>
            ) : history.length === 0 ? (
              <div className="p-6 text-center font-mono text-xs uppercase tracking-wider text-stone">
                AUCUN PARTIEL BLANC RENDU SUR CETTE UE POUR L&apos;INSTANT.
              </div>
            ) : (
              <div className="divide-y divide-border">
                {history.map((item) => (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-3 p-4"
                  >
                    <div>
                      <p className="font-mono text-xs font-bold uppercase text-ink">
                        NOTE :{" "}
                        <span
                          className={
                            item.grade20 >= 10 ? "text-forest" : "text-carmine"
                          }
                        >
                          {item.grade20} / 20
                        </span>{" "}
                        · {item.score}/{item.totalQuestions}
                      </p>
                      <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-stone">
                        {new Date(item.completedAt).toLocaleDateString(
                          "fr-FR",
                          {
                            day: "2-digit",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          }
                        )}{" "}
                        · DURÉE {item.durationMinutes} MIN
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-1.5">
                      {item.chapterBreakdown.slice(0, 3).map((ch) => (
                        <span
                          key={ch.chapterTitle}
                          className="border border-border bg-paper px-2 py-0.5 font-mono text-[10px] uppercase text-stone"
                        >
                          {ch.chapterTitle.slice(0, 14)} : {ch.percent}%
                        </span>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
