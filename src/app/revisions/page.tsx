"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "next-auth/react";
import {
  Award,
  Brain,
  Check,
  CheckCircle2,
  FileText,
  Flame,
  Loader2,
  Power,
  RefreshCw,
  RotateCcw,
  Sparkles,
  Trophy,
  XCircle,
} from "lucide-react";
import { AppShell } from "@/components/AppShell";
import { CommunityQuizSection } from "@/components/CommunityQuizSection";
import { useSpix } from "@/components/SpixContext";
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
  {
    ssr: false,
    loading: () => (
      <div className="flex h-64 items-center justify-center border border-border bg-paper font-mono text-xs uppercase tracking-wider text-stone">
        CHARGEMENT DE L&apos;IMAGE DU COURS...
      </div>
    ),
  }
);

interface UserRevisionState {
  revisionEnabled: boolean;
  currentStreak: number;
  bestStreak: number;
  lastRevisionDate: string | null;
  totalRevisionPoints: number;
  completedToday: boolean;
}

interface DailySessionData {
  id: string;
  dateKey: string;
  questions: RevisionQuestion[];
  answers: Record<string, RevisionAnswerValue>;
  score: number;
  totalQuestions: number;
  completed: boolean;
  completedAt: string | null;
}

interface LeaderboardEntry {
  id: string;
  name: string;
  currentStreak: number;
  bestStreak: number;
  totalRevisionPoints: number;
  completedToday: boolean;
}

interface ErrorBookCard {
  id: string;
  fingerprint: string;
  ueId: string;
  ueCode: string;
  chapterId: string;
  chapterTitle: string;
  wrongCount: number;
  srsBox: number;
  mastered: boolean;
  nextReviewDate: string;
  question: RevisionQuestion;
}

interface WeakChapterSummary {
  ueId: string;
  ueCode: string;
  chapterTitle: string;
  errorCount: number;
  activeItems: number;
}

interface UserErrorBookPayload {
  items: ErrorBookCard[];
  weakChapters: WeakChapterSummary[];
  dueCount: number;
  activeCount: number;
  masteredCount: number;
}

interface SharedQuizMeta {
  dateKey: string;
  ueCode: string | null;
  ueTitle: string | null;
  generatedAt: string;
  generatedByAi: boolean;
}

interface RevisionsPayload {
  userState: UserRevisionState;
  todayKey: string;
  hasCourseContent: boolean;
  todaySession: DailySessionData | null;
  leaderboard: LeaderboardEntry[];
  errorBook?: UserErrorBookPayload;
  gradingResults?: Record<string, boolean>;
  sharedQuizMeta?: SharedQuizMeta | null;
}

const TYPE_LABELS: Record<RevisionQuestion["type"], string> = {
  QCU: "QCU · CHOIX UNIQUE",
  QCM: "QCM · CHOIX MULTIPLES",
  QROC: "QROC · RÉPONSE OUVERTE COURTE",
  FLASHCARD: "FLASHCARD · RECTO / VERSO",
  FILL_BLANK: "PHRASE À TROU",
  IMAGE_POINT: "POINTAGE SUR IMAGE",
};

export default function RevisionsPage() {
  const { data: session } = useSession();
  const { setPageContext } = useSpix();

  const [data, setData] = useState<RevisionsPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, RevisionAnswerValue>>(
    {}
  );
  const [gradingResults, setGradingResults] = useState<
    Record<string, boolean> | null
  >(null);
  const [flippedCards, setFlippedCards] = useState<Record<string, boolean>>({});
  const [revealedErrorIds, setRevealedErrorIds] = useState<
    Record<string, boolean>
  >({});

  useEffect(() => {
    setPageContext({ mode: "GLOBAL" });
  }, [setPageContext]);

  const loadRevisions = useCallback(async () => {
    try {
      const res = await fetch("/api/revisions", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as RevisionsPayload;
      setData(json);
      if (json.todaySession) {
        setAnswers(json.todaySession.answers || {});
        if (!json.todaySession.completed) {
          setGradingResults(null);
          setFlippedCards({});
        }
      }
    } catch {
      setError("Impossible de charger les révisions.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRevisions();
  }, [loadRevisions]);

  async function postAction(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/revisions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as RevisionsPayload & { error?: string };
      if (!res.ok) {
        setError(json.error || "Erreur lors de l'opération.");
        return;
      }
      setData(json);
      if (json.todaySession) {
        setAnswers(json.todaySession.answers || {});
      }
      if (json.gradingResults) {
        setGradingResults(json.gradingResults);
      } else if (json.todaySession && !json.todaySession.completed) {
        setGradingResults(null);
        setFlippedCards({});
      }
    } finally {
      setBusy(false);
    }
  }

  function handleSelectQCU(questionId: string, optionIdx: number) {
    if (data?.todaySession?.completed) return;
    setAnswers((prev) => ({ ...prev, [questionId]: [optionIdx] }));
  }

  function handleToggleQCM(questionId: string, optionIdx: number) {
    if (data?.todaySession?.completed) return;
    setAnswers((prev) => {
      const current = Array.isArray(prev[questionId])
        ? (prev[questionId] as number[])
        : [];
      const exists = current.includes(optionIdx);
      const next = exists
        ? current.filter((i) => i !== optionIdx)
        : [...current, optionIdx];
      return { ...prev, [questionId]: next };
    });
  }

  function handleTextAnswer(questionId: string, val: string) {
    if (data?.todaySession?.completed) return;
    setAnswers((prev) => ({ ...prev, [questionId]: val }));
  }

  function handleImagePoint(questionId: string, val: ImagePointAnswer) {
    if (data?.todaySession?.completed) return;
    setAnswers((prev) => ({ ...prev, [questionId]: val }));
  }

  const userState = data?.userState;
  const sessionData = data?.todaySession;
  const sharedMeta = data?.sharedQuizMeta || null;
  const isYearAdmin = session?.user?.globalRole === "YEAR_ADMIN";
  const leaderboard = data?.leaderboard || [];
  const errorBook = data?.errorBook;
  const activeErrorItems = (errorBook?.items || []).filter(
    (item) => !item.mastered
  );
  const sessionUe = sessionData?.questions?.[0]
    ? {
        code: sessionData.questions[0].ueCode,
        title: sessionData.questions[0].ueTitle,
      }
    : null;
  const sessionGeneratedByAi = Boolean(
    sessionData?.questions?.some((q) => q.generatedByAi)
  );

  return (
    <AppShell>
      <div className="space-y-6">
        {/* Top Masthead + Activation Toggle */}
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
          <div>
            <h1 className="text-lg font-bold uppercase tracking-tight text-ink">
              RÉVISIONS JOURNALIÈRES &amp; CLASSEMENT DE STREAK
            </h1>
            <p className="font-mono text-[11px] uppercase tracking-wider text-stone">
              [ QUIZ JOURNALIER COMMUN À TOUS · GÉNÉRÉ AUTOMATIQUEMENT À 06H00 ·
              QCU · QCM · QROC · FLASHCARDS ]
            </p>
          </div>

          {userState && (
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                postAction({
                  action: "TOGGLE",
                  enabled: !userState.revisionEnabled,
                })
              }
              className={`inline-flex items-center gap-2 border px-4 py-2 font-mono text-xs uppercase tracking-wider transition-colors disabled:opacity-50 ${
                userState.revisionEnabled
                  ? "border-forest bg-forest/10 font-semibold text-forest hover:bg-forest/20"
                  : "border-ink bg-ink text-card hover:bg-ink/90"
              }`}
            >
              <Power className="h-3.5 w-3.5" />
              <span>
                {userState.revisionEnabled
                  ? "RÉVISIONS JOURNALIÈRES : ACTIVÉES"
                  : "ACTIVER LES RÉVISIONS JOURNALIÈRES"}
              </span>
            </button>
          )}
        </div>

        {error && (
          <div className="border border-carmine/40 bg-carmine/10 px-4 py-2.5 font-mono text-xs text-carmine">
            {error}
          </div>
        )}

        {/* Metrics Row */}
        {userState && (
          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <div
              className="border border-border bg-card p-4"
              style={{ borderTop: "3px solid #D99B26" }}
            >
              <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-stone">
                <span>STREAK ACTUEL</span>
                <Flame className="h-4 w-4 text-amber" />
              </div>
              <p className="mt-1.5 font-mono text-xl font-bold text-ink">
                {userState.currentStreak} JOURS
              </p>
            </div>

            <div
              className="border border-border bg-card p-4"
              style={{ borderTop: "3px solid #3D6B99" }}
            >
              <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-stone">
                <span>RECORD PERSONNEL</span>
                <Trophy className="h-4 w-4 text-slate" />
              </div>
              <p className="mt-1.5 font-mono text-xl font-bold text-ink">
                {userState.bestStreak} JOURS
              </p>
            </div>

            <div
              className="border border-border bg-card p-4"
              style={{ borderTop: "3px solid #3B7A57" }}
            >
              <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-stone">
                <span>POINTS CUMULÉS</span>
                <Award className="h-4 w-4 text-forest" />
              </div>
              <p className="mt-1.5 font-mono text-xl font-bold text-ink">
                {userState.totalRevisionPoints} PTS
              </p>
            </div>

            <div
              className="border border-border bg-card p-4"
              style={{
                borderTop: `3px solid ${
                  userState.completedToday ? "#3B7A57" : "#C83E4D"
                }`,
              }}
            >
              <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider text-stone">
                <span>SÉANCE DU JOUR</span>
                <CheckCircle2
                  className={`h-4 w-4 ${
                    userState.completedToday ? "text-forest" : "text-stone"
                  }`}
                />
              </div>
              <p
                className={`mt-1.5 font-mono text-sm font-bold uppercase ${
                  userState.completedToday ? "text-forest" : "text-ink"
                }`}
              >
                {userState.completedToday
                  ? "VALIDÉE AUJOURD'HUI"
                  : userState.revisionEnabled
                  ? "EN ATTENTE"
                  : "INACTIVE"}
              </p>
            </div>
          </div>
        )}

        {loading || !data ? (
          <div className="border border-border bg-card p-8 font-mono text-xs uppercase tracking-wider text-stone">
            CHARGEMENT DES SÉANCES DE RÉVISION...
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
            {/* Left 8 Columns: Daily Quiz Engine */}
            <section className="space-y-4 lg:col-span-8">
              {!userState?.revisionEnabled ? (
                <div
                  className="border border-border bg-card p-8"
                  style={{ borderTop: "3px solid #D99B26" }}
                >
                  <p className="font-mono text-xs font-semibold uppercase tracking-wider text-stone">
                    PROGRAMME QUOTIDIEN DÉSACTIVÉ
                  </p>
                  <h2 className="mt-2 text-lg font-bold uppercase tracking-tight text-ink">
                    PRÉPAREZ VOS PARTIELS SUR LE LONG TERME
                  </h2>
                  <p className="mt-2 text-sm leading-relaxed text-stone">
                    Activez les révisions journalières pour qu&apos;Ara génère
                    chaque jour par IA une séance composée de QCU, QCM, QROC et
                    Flashcards sur des cours tirés aléatoirement dans une UE
                    aléatoire, et maintenez votre streak dans le classement de
                    la promotion.
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      postAction({ action: "TOGGLE", enabled: true })
                    }
                    className="mt-5 inline-flex items-center gap-2 border border-ink bg-ink px-5 py-2.5 font-mono text-xs uppercase tracking-wider text-card hover:bg-ink/90"
                  >
                    <Flame className="h-4 w-4" />
                    <span>ACTIVER ET GÉNÉRER MA SÉANCE DU JOUR</span>
                  </button>
                </div>
              ) : !data.hasCourseContent ? (
                <div className="border border-border bg-card p-8 text-center">
                  <p className="font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                    AUCUN COURS PDF DISPONIBLE POUR GÉNÉRER DES QUESTIONS
                  </p>
                  <p className="mt-2 text-sm text-stone">
                    Déposez au moins un document PDF dans une UE afin
                    qu&apos;Ara puisse extraire les chapitres et créer vos
                    quiz quotidiens.
                  </p>
                  <Link
                    href="/"
                    className="mt-4 inline-block border border-ink bg-ink px-4 py-2 font-mono text-xs uppercase tracking-wider text-card"
                  >
                    VOIR LES UE
                  </Link>
                </div>
              ) : !sessionData || sessionData.questions.length === 0 ? (
                <div className="border border-border bg-card p-8 text-center">
                  <p className="font-mono text-xs uppercase tracking-wider text-stone">
                    PRÊT À GÉNÉRER VOTRE SÉANCE DU JOUR ({data.todayKey})
                  </p>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => postAction({ action: "GENERATE_DAILY" })}
                    className="mt-4 inline-flex items-center gap-2 border border-ink bg-ink px-5 py-2.5 font-mono text-xs uppercase tracking-wider text-card"
                  >
                    {busy ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4" />
                    )}
                    <span>GÉNÉRER LE QUIZ DU JOUR</span>
                  </button>
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Session Status Header */}
                  <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-card px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-bold uppercase tracking-wider text-ink">
                        SÉANCE DU {sessionData.dateKey} ·{" "}
                        {sessionData.questions.length} QUESTIONS
                      </span>
                      <span className="border border-ink bg-ink px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-card">
                        QUIZ COMMUN 06H00
                        {sharedMeta?.generatedAt
                          ? ` · ${new Date(
                              sharedMeta.generatedAt
                            ).toLocaleTimeString("fr-FR", {
                              hour: "2-digit",
                              minute: "2-digit",
                            })}`
                          : ""}
                      </span>
                      {sessionUe && (
                        <span className="border border-border bg-paper px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink">
                          UE : {sessionUe.code} — {sessionUe.title}
                        </span>
                      )}
                      {sessionGeneratedByAi && (
                        <span className="inline-flex items-center gap-1 border border-forest/40 bg-forest/10 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-forest">
                          <Sparkles className="h-3 w-3" />
                          <span>GÉNÉRÉ PAR IA SPIX</span>
                        </span>
                      )}
                      {sessionData.completed && (
                        <span className="bg-badge-bg px-2 py-0.5 font-mono text-[11px] font-bold uppercase tracking-wider text-badge-text">
                          SCORE : {sessionData.score} /{" "}
                          {sessionData.totalQuestions}
                        </span>
                      )}
                    </div>

                    <div className="flex flex-wrap items-center gap-2">
                      {isYearAdmin && (
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() =>
                            postAction({
                              action: "GENERATE_DAILY",
                              forceShared: true,
                            })
                          }
                          className="inline-flex items-center gap-1.5 border border-ink bg-paper px-3 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-ink hover:bg-pinned disabled:opacity-50"
                        >
                          <RefreshCw
                            className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`}
                          />
                          <span>REGÉNÉRER LE QUIZ COMMUN (POUR TOUS)</span>
                        </button>
                      )}
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => postAction({ action: "GENERATE_BONUS" })}
                        className="inline-flex items-center gap-1.5 border border-border bg-paper px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-ink hover:border-ink disabled:opacity-50"
                      >
                        <RefreshCw
                          className={`h-3.5 w-3.5 ${busy ? "animate-spin" : ""}`}
                        />
                        <span>QUIZ BONUS D&apos;ENTRAÎNEMENT</span>
                      </button>
                    </div>
                  </div>

                  {/* Questions List */}
                  {sessionData.questions.map((q, qIdx) => {
                    const isGraded = sessionData.completed;
                    const isCorrect = gradingResults
                      ? gradingResults[q.id]
                      : undefined;

                    return (
                      <article
                        key={q.id}
                        className={`ara-animate-in border bg-card p-5 ${
                          isGraded && isCorrect === true
                            ? "border-forest"
                            : isGraded && isCorrect === false
                            ? "border-carmine"
                            : "border-border"
                        }`}
                      >
                        {/* Meta Header */}
                        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2.5">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="border border-ink bg-ink px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-card">
                              Q{qIdx + 1}
                            </span>
                            <span className="bg-badge-bg px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-badge-text">
                              {TYPE_LABELS[q.type]}
                            </span>
                            <span className="border border-border bg-paper px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-stone">
                              {q.ueCode} · {q.chapterTitle}
                            </span>
                          </div>

                          <Link
                            href={`/ue/${q.ueId}?doc=${encodeURIComponent(
                              q.documentId
                            )}&page=${q.pageNumber}`}
                            className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-badge-text hover:underline"
                          >
                            <FileText className="h-3 w-3" />
                            <span>
                              {q.fileName} · P.{q.pageNumber}
                            </span>
                          </Link>
                        </div>

                        <p className="mb-4 text-sm font-semibold leading-relaxed text-ink">
                          {q.prompt}
                        </p>

                        {/* QCU / QCM */}
                        {(q.type === "QCU" || q.type === "QCM") && q.options && (
                          <div className="space-y-2">
                            {q.options.map((opt, optIdx) => {
                              const selectedArr = Array.isArray(answers[q.id])
                                ? (answers[q.id] as number[])
                                : [];
                              const isSelected = selectedArr.includes(optIdx);
                              const isExpected =
                                q.correctIndices?.includes(optIdx) ?? false;

                              let boxStyle =
                                "border-border bg-paper text-ink hover:border-ink";
                              if (isGraded) {
                                if (isExpected) {
                                  boxStyle =
                                    "border-forest bg-forest/10 text-ink";
                                } else if (isSelected && !isExpected) {
                                  boxStyle =
                                    "border-carmine bg-carmine/10 text-ink";
                                }
                              } else if (isSelected) {
                                boxStyle = "border-ink bg-pinned text-ink";
                              }

                              return (
                                <button
                                  key={optIdx}
                                  type="button"
                                  disabled={isGraded}
                                  onClick={() =>
                                    q.type === "QCU"
                                      ? handleSelectQCU(q.id, optIdx)
                                      : handleToggleQCM(q.id, optIdx)
                                  }
                                  className={`flex w-full items-start gap-3 border p-3 text-left text-sm transition-colors ${boxStyle}`}
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
                                  <span className="flex-1 leading-snug">
                                    {opt}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}

                        {/* QROC */}
                        {q.type === "QROC" && (
                          <div className="space-y-3">
                            <textarea
                              rows={3}
                              disabled={isGraded}
                              value={
                                typeof answers[q.id] === "string"
                                  ? (answers[q.id] as string)
                                  : ""
                              }
                              onChange={(e) =>
                                handleTextAnswer(q.id, e.target.value)
                              }
                              placeholder="Rédigez votre réponse courte (mot-clé, définition, mécanisme)..."
                              className="w-full border border-border bg-paper px-3 py-2.5 text-sm text-ink placeholder:text-stone focus:border-ink focus:outline-none disabled:opacity-75"
                            />

                            {isGraded && q.correctAnswer && (
                              <div className="border border-forest/40 bg-forest/10 p-3 text-xs text-ink">
                                <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-forest">
                                  RÉPONSE ATTENDUE : {q.correctAnswer}
                                </p>
                                {q.acceptedKeywords &&
                                  q.acceptedKeywords.length > 1 && (
                                    <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-stone">
                                      MOTS-CLÉS ACCEPTÉS :{" "}
                                      {q.acceptedKeywords.join(" · ")}
                                    </p>
                                  )}
                              </div>
                            )}
                          </div>
                        )}

                        {/* FLASHCARD */}
                        {q.type === "FLASHCARD" && (
                          <div className="space-y-3">
                            {!flippedCards[q.id] && !isGraded ? (
                              <div className="ara-flip-in border border-border bg-paper p-5 text-center">
                                <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                                  RECTO · FORMULEZ MENTALEMENT LA RÉPONSE PUIS
                                  RETOURNEZ LA CARTE
                                </p>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setFlippedCards((prev) => ({
                                      ...prev,
                                      [q.id]: true,
                                    }))
                                  }
                                  className="mt-3 inline-flex items-center gap-2 border border-ink bg-ink px-4 py-2 font-mono text-xs uppercase tracking-wider text-card hover:bg-ink/90"
                                >
                                  <RotateCcw className="h-3.5 w-3.5" />
                                  <span>
                                    RETOURNER LA FLASHCARD (VOIR LE VERSO)
                                  </span>
                                </button>
                              </div>
                            ) : (
                              <div className="ara-flip-in space-y-3">
                                <div
                                  className="border border-border bg-paper p-4"
                                  style={{ borderLeft: "3px solid #3D6B99" }}
                                >
                                  <div className="mb-1.5 flex items-center justify-between gap-2">
                                    <span className="font-mono text-[10px] font-bold uppercase tracking-wider text-slate">
                                      VERSO · RÉPONSE DU COURS
                                    </span>
                                    {!isGraded && (
                                      <button
                                        type="button"
                                        onClick={() =>
                                          setFlippedCards((prev) => ({
                                            ...prev,
                                            [q.id]: false,
                                          }))
                                        }
                                        className="font-mono text-[10px] uppercase tracking-wider text-stone hover:text-ink"
                                      >
                                        MASQUER LE VERSO
                                      </button>
                                    )}
                                  </div>
                                  <p className="text-sm leading-relaxed text-ink">
                                    {q.flashcardBack || q.explanation}
                                  </p>
                                </div>

                                <div className="flex flex-wrap gap-2">
                                  <button
                                    type="button"
                                    disabled={isGraded}
                                    onClick={() =>
                                      handleTextAnswer(q.id, "KNOWN")
                                    }
                                    className={`inline-flex flex-1 items-center justify-center gap-1.5 border px-3 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider transition-colors ${
                                      answers[q.id] === "KNOWN"
                                        ? "border-forest bg-forest text-card"
                                        : "border-forest/50 bg-forest/10 text-forest hover:bg-forest/20"
                                    } disabled:opacity-80`}
                                  >
                                    <Check className="h-3.5 w-3.5" />
                                    <span>JE SAVAIS (MAÎTRISÉ)</span>
                                  </button>

                                  <button
                                    type="button"
                                    disabled={isGraded}
                                    onClick={() =>
                                      handleTextAnswer(q.id, "REVIEW")
                                    }
                                    className={`inline-flex flex-1 items-center justify-center gap-1.5 border px-3 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider transition-colors ${
                                      answers[q.id] === "REVIEW"
                                        ? "border-carmine bg-carmine text-card"
                                        : "border-carmine/50 bg-carmine/10 text-carmine hover:bg-carmine/20"
                                    } disabled:opacity-80`}
                                  >
                                    <XCircle className="h-3.5 w-3.5" />
                                    <span>À REVOIR (CARNET SRS)</span>
                                  </button>
                                </div>
                              </div>
                            )}
                          </div>
                        )}

                        {/* FILL_BLANK */}
                        {q.type === "FILL_BLANK" && (
                          <div className="space-y-3">
                            <div className="border border-border bg-paper p-3.5 text-sm leading-relaxed text-ink">
                              {q.sentenceWithBlank}
                            </div>

                            <input
                              type="text"
                              disabled={isGraded}
                              value={
                                typeof answers[q.id] === "string"
                                  ? (answers[q.id] as string)
                                  : ""
                              }
                              onChange={(e) =>
                                handleTextAnswer(q.id, e.target.value)
                              }
                              placeholder="Tapez le terme exact ou sélectionnez-le ci-dessous..."
                              className="w-full border border-border bg-paper px-3 py-2 font-mono text-xs text-ink focus:border-ink focus:outline-none disabled:opacity-75"
                            />

                            {q.wordBank && q.wordBank.length > 0 && (
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
                                  SUGGESTIONS :
                                </span>
                                {q.wordBank.map((term) => {
                                  const selected = answers[q.id] === term;
                                  return (
                                    <button
                                      key={term}
                                      type="button"
                                      disabled={isGraded}
                                      onClick={() =>
                                        handleTextAnswer(q.id, term)
                                      }
                                      className={`border px-2.5 py-1 font-mono text-xs transition-colors ${
                                        selected
                                          ? "border-ink bg-ink text-card"
                                          : "border-border bg-paper text-ink hover:border-ink"
                                      }`}
                                    >
                                      {term}
                                    </button>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        )}

                        {/* IMAGE_POINT */}
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
                            disabled={isGraded}
                            showCorrection={isGraded}
                            onChange={(val) => handleImagePoint(q.id, val)}
                          />
                        )}

                        {/* Correction / Explanation Box */}
                        {isGraded && (
                          <div className="mt-4 flex items-start gap-2.5 border-t border-border pt-3">
                            {isCorrect === false ? (
                              <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-carmine" />
                            ) : (
                              <Check className="mt-0.5 h-4 w-4 shrink-0 text-forest" />
                            )}
                            <div className="text-xs leading-relaxed text-ink">
                              <p className="font-mono text-[10px] font-bold uppercase tracking-wider text-stone">
                                CORRECTION &amp; SOURCE
                              </p>
                              <p className="mt-0.5">{q.explanation}</p>
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })}

                  {/* Submit Button */}
                  {!sessionData.completed && (
                    <div className="flex justify-end border border-border bg-card p-4">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          postAction({ action: "SUBMIT", answers })
                        }
                        className="inline-flex items-center gap-2 border border-ink bg-ink px-6 py-3 font-mono text-xs font-semibold uppercase tracking-wider text-card hover:bg-ink/90 disabled:opacity-50"
                      >
                        {busy ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Flame className="h-4 w-4 text-amber" />
                        )}
                        <span>VALIDER LA SÉANCE &amp; MON STREAK</span>
                      </button>
                    </div>
                  )}
                </div>
              )}
            </section>

            {/* Right 4 Columns: Streak Leaderboard */}
            <aside className="space-y-4 lg:col-span-4">
              <div
                className="border border-border bg-card"
                style={{ borderTop: "3px solid #D99B26" }}
              >
                <div className="flex items-center justify-between border-b border-border bg-paper px-4 py-3">
                  <div className="flex items-center gap-2">
                    <Trophy className="h-4 w-4 text-amber" />
                    <span className="font-mono text-xs font-bold uppercase tracking-wider text-ink">
                      CLASSEMENT DE STREAK
                    </span>
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
                    PROMO
                  </span>
                </div>

                {leaderboard.length === 0 ? (
                  <div className="p-6 text-center font-mono text-xs uppercase tracking-wider text-stone">
                    AUCUN ÉTUDIANT N&apos;A ENCORE ACTIVÉ LES RÉVISIONS.
                  </div>
                ) : (
                  <div className="divide-y divide-border">
                    {leaderboard.map((entry, idx) => {
                      const isMe = entry.id === session?.user?.id;
                      return (
                        <div
                          key={entry.id}
                          className={`flex items-center justify-between gap-3 px-4 py-3 ${
                            isMe ? "bg-pinned" : "bg-card"
                          }`}
                        >
                          <div className="flex min-w-0 items-center gap-3">
                            <span
                              className={`flex h-7 w-7 shrink-0 items-center justify-center border font-mono text-xs font-bold ${
                                idx === 0
                                  ? "border-ink bg-ink text-card"
                                  : "border-border bg-paper text-ink"
                              }`}
                            >
                              {String(idx + 1).padStart(2, "0")}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate text-sm font-bold text-ink">
                                {entry.name}
                                {isMe && (
                                  <span className="ml-1.5 font-mono text-[10px] uppercase text-badge-text">
                                    (VOUS)
                                  </span>
                                )}
                              </p>
                              <p className="font-mono text-[10px] uppercase tracking-wider text-stone">
                                RECORD : {entry.bestStreak}J ·{" "}
                                {entry.totalRevisionPoints} PTS
                              </p>
                            </div>
                          </div>

                          <div className="shrink-0 text-right">
                            <span className="inline-flex items-center gap-1 border border-border bg-paper px-2 py-0.5 font-mono text-xs font-bold text-ink">
                              <Flame className="h-3 w-3 text-amber" />
                              {entry.currentStreak}J
                            </span>
                            {entry.completedToday && (
                              <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-forest">
                                ✓ FAIT AUJOURD&apos;HUI
                              </p>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </aside>
          </div>
        )}

        {/* Carnet d'Erreurs & Répétition Espacée (SRS) */}
        {!loading && errorBook && (
          <section className="space-y-4 border-t border-border pt-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="flex items-center gap-2 text-base font-bold uppercase tracking-tight text-ink">
                  <Brain className="h-4 w-4 text-carmine" />
                  <span>CARNET D&apos;ERREURS &amp; RÉPÉTITION ESPACÉE (SRS)</span>
                </h2>
                <p className="font-mono text-[11px] uppercase tracking-wider text-stone">
                  [ REPRISE AUTOMATIQUE DES NOTIONS RATÉES EN QUIZ OU EN PARTIEL BLANC ]
                </p>
              </div>

              <div className="flex flex-wrap items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
                <span className="border border-carmine/40 bg-carmine/10 px-2.5 py-1 text-carmine">
                  {errorBook.dueCount} À REVOIR AUJOURD&apos;HUI
                </span>
                <span className="border border-border bg-card px-2.5 py-1 text-ink">
                  {errorBook.activeCount} ACTIVES · {errorBook.masteredCount}{" "}
                  MAÎTRISÉES
                </span>
              </div>
            </div>

            {activeErrorItems.length === 0 ? (
              <div className="border border-border bg-card p-6 text-center font-mono text-xs uppercase tracking-wider text-stone">
                CARNET D&apos;ERREURS VIERGE — TOUTES VOS QUESTIONS RATÉES ONT
                ÉTÉ MAÎTRISÉES OU AUCUNE ERREUR ENREGISTRÉE.
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
                {/* Weak Chapters Ranking */}
                <div className="border border-border bg-card lg:col-span-4">
                  <div className="border-b border-border bg-paper px-4 py-2.5 font-mono text-xs font-semibold uppercase tracking-wider text-ink">
                    CHAPITRES PRIORITAIRES ({errorBook.weakChapters.length})
                  </div>
                  <div className="divide-y divide-border">
                    {errorBook.weakChapters.map((wc) => (
                      <div key={`${wc.ueCode}-${wc.chapterTitle}`} className="p-3.5">
                        <div className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-wider">
                          <span className="bg-badge-bg px-1.5 py-0.5 font-bold text-badge-text">
                            {wc.ueCode}
                          </span>
                          <span className="text-carmine">
                            {wc.errorCount} ERREUR{wc.errorCount > 1 ? "S" : ""}
                          </span>
                        </div>
                        <p className="mt-1.5 text-xs font-semibold text-ink">
                          {wc.chapterTitle}
                        </p>
                        <p className="mt-0.5 font-mono text-[10px] uppercase text-stone">
                          {wc.activeItems} NOTION{wc.activeItems > 1 ? "S" : ""} EN
                          COURS DE RÉTENTION
                        </p>
                      </div>
                    ))}
                  </div>
                </div>

                {/* SRS Error Cards */}
                <div className="space-y-3 lg:col-span-8">
                  {activeErrorItems.slice(0, 6).map((item) => {
                    const q = item.question;
                    const revealed = Boolean(revealedErrorIds[item.id]);
                    const isDue = item.nextReviewDate <= (data?.todayKey || "");

                    return (
                      <article
                        key={item.id}
                        className="border border-border bg-card p-4"
                        style={{
                          borderLeft: `3px solid ${
                            isDue ? "#C83E4D" : "#D99B26"
                          }`,
                        }}
                      >
                        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider">
                            <span className="bg-badge-bg px-2 py-0.5 font-bold text-badge-text">
                              {item.ueCode}
                            </span>
                            <span className="border border-border bg-paper px-2 py-0.5 text-ink">
                              BOÎTE SRS {item.srsBox}/5
                            </span>
                            <span className="border border-carmine/30 bg-carmine/10 px-2 py-0.5 text-carmine">
                              RATÉE {item.wrongCount}×
                            </span>
                          </div>
                          <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
                            PROCHAINE RÉVISION : {item.nextReviewDate}
                          </span>
                        </div>

                        <p className="text-sm font-semibold text-ink">
                          {q.prompt}
                        </p>
                        {q.sentenceWithBlank && (
                          <p className="mt-1.5 border border-border bg-paper px-3 py-2 text-xs text-ink">
                            {q.sentenceWithBlank}
                          </p>
                        )}

                        {!revealed ? (
                          <button
                            type="button"
                            onClick={() =>
                              setRevealedErrorIds((p) => ({
                                ...p,
                                [item.id]: true,
                              }))
                            }
                            className="mt-3 inline-flex items-center gap-1.5 border border-ink bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:bg-pinned"
                          >
                            <RotateCcw className="h-3 w-3" />
                            <span>AFFICHER LA RÉPONSE &amp; ÉVALUER (SRS)</span>
                          </button>
                        ) : (
                          <div className="mt-3 space-y-3 border-t border-border pt-3">
                            <div className="border border-forest/40 bg-forest/10 p-3 text-xs text-ink">
                              {q.options && q.correctIndices && (
                                <p className="font-semibold">
                                  Réponse(s) attendue(s) :{" "}
                                  {q.correctIndices
                                    .map((i) => q.options?.[i])
                                    .filter(Boolean)
                                    .join(" · ")}
                                </p>
                              )}
                              {q.correctAnswer && (
                                <p className="font-semibold">
                                  {q.type === "QROC"
                                    ? "Réponse attendue : "
                                    : "Mot-clé attendu : "}
                                  {q.correctAnswer}
                                </p>
                              )}
                              {q.flashcardBack && (
                                <p className="font-semibold">
                                  Verso : {q.flashcardBack}
                                </p>
                              )}
                              <p className="mt-1 text-stone">{q.explanation}</p>
                            </div>

                            <div className="flex flex-wrap items-center gap-1.5">
                              {(
                                [
                                  {
                                    rating: "AGAIN",
                                    label: "À REVOIR (<1M)",
                                    cls: "border-carmine bg-carmine/10 text-carmine hover:bg-carmine hover:text-card",
                                  },
                                  {
                                    rating: "HARD",
                                    label: "DIFFICILE (1J)",
                                    cls: "border-amber bg-amber/15 text-ink hover:bg-amber hover:text-card",
                                  },
                                  {
                                    rating: "GOOD",
                                    label: "BIEN (3J)",
                                    cls: "border-badge-text bg-badge-bg text-badge-text hover:bg-badge-text hover:text-card",
                                  },
                                  {
                                    rating: "EASY",
                                    label: "FACILE · MAÎTRISÉ (7J)",
                                    cls: "border-forest bg-forest/15 text-forest hover:bg-forest hover:text-card",
                                  },
                                ] as const
                              ).map((btn) => (
                                <button
                                  key={btn.rating}
                                  type="button"
                                  disabled={busy}
                                  onClick={() => {
                                    setRevealedErrorIds((p) => ({
                                      ...p,
                                      [item.id]: false,
                                    }));
                                    void postAction({
                                      action: "REVIEW_ERROR",
                                      errorItemId: item.id,
                                      rating: btn.rating,
                                    });
                                  }}
                                  className={`border px-2.5 py-1.5 font-mono text-[10px] font-semibold uppercase tracking-wider transition-colors ${btn.cls}`}
                                >
                                  {btn.label}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </article>
                    );
                  })}
                </div>
              </div>
            )}
          </section>
        )}

        {/* Community Custom Quizzes & Image Occlusion Editor */}
        <section className="border-t border-border pt-6">
          <CommunityQuizSection />
        </section>
      </div>
    </AppShell>
  );
}
