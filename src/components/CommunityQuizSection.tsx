"use client";

import { useCallback, useEffect, useState } from "react";
import { useSession } from "next-auth/react";
import {
  ArrowUp,
  Check,
  Eye,
  EyeOff,
  Image as ImageIcon,
  Loader2,
  Pin,
  PinOff,
  Play,
  Plus,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import {
  ImageOcclusionEditor,
  type PdfPickerDoc,
} from "@/components/ImageOcclusionEditor";
import {
  normalizeQuizText,
  type CustomQuestionType,
  type CustomQuizQuestion,
} from "@/lib/quiz-types";

interface UEOption {
  id: string;
  code: string;
  title: string;
}

interface CommunityQuizSummary {
  id: string;
  authorId: string;
  ueId: string | null;
  title: string;
  description: string;
  isPublic: boolean;
  isPinned: boolean;
  attemptsCount: number;
  createdAt: string;
  author: { id: string; name: string; globalRole: string };
  ue: { id: string; code: string; title: string; accentColor: string } | null;
  questionCount: number;
  hasOcclusion: boolean;
  upvoteCount: number;
  hasUpvoted: boolean;
}

interface LoadedQuizDetail extends CommunityQuizSummary {
  questions: CustomQuizQuestion[];
}

interface CommunityQuizSectionProps {
  fixedUeId?: string;
  canManageFixedUe?: boolean;
  ues?: UEOption[];
  documents?: PdfPickerDoc[];
}

type PlayerAnswer =
  | Record<string, string> // IMAGE_OCCLUSION: maskId -> typed legend
  | number[] // QCU / QCM
  | string; // FILL_BLANK

export function CommunityQuizSection({
  fixedUeId,
  canManageFixedUe = false,
  ues = [],
  documents = [],
}: CommunityQuizSectionProps) {
  const { data: session } = useSession();

  const [quizzes, setQuizzes] = useState<CommunityQuizSummary[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [allDocs, setAllDocs] = useState<PdfPickerDoc[]>(documents);
  const [allUes, setAllUes] = useState<UEOption[]>(ues);

  // Editor state
  const [editorOpen, setEditorOpen] = useState(false);
  const [quizTitle, setQuizTitle] = useState("");
  const [quizDescription, setQuizDescription] = useState("");
  const [quizUeId, setQuizUeId] = useState(fixedUeId || "");
  const [quizPublic, setQuizPublic] = useState(true);
  const [draftQuestions, setDraftQuestions] = useState<CustomQuizQuestion[]>([
    {
      id: `cq-${Date.now()}`,
      type: "IMAGE_OCCLUSION",
      prompt: "Légendez chaque zone masquée sur ce schéma de cours :",
      imageDataUrl: "",
      masks: [],
      showWordBank: true,
    },
  ]);
  const [savingQuiz, setSavingQuiz] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  // Player state
  const [activeQuiz, setActiveQuiz] = useState<LoadedQuizDetail | null>(null);
  const [playerAnswers, setPlayerAnswers] = useState<
    Record<string, PlayerAnswer>
  >({});
  const [playerSubmitted, setPlayerSubmitted] = useState(false);
  const [focusedMaskId, setFocusedMaskId] = useState<string | null>(null);
  const [revealedOcclusion, setRevealedOcclusion] = useState<
    Record<string, boolean>
  >({});

  useEffect(() => {
    if (documents.length > 0) setAllDocs(documents);
  }, [documents]);

  useEffect(() => {
    if (ues.length > 0) setAllUes(ues);
  }, [ues]);

  useEffect(() => {
    if (allDocs.length === 0) {
      fetch("/api/documents", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { documents?: PdfPickerDoc[] } | null) => {
          if (data?.documents) setAllDocs(data.documents);
        })
        .catch(() => {});
    }
    if (allUes.length === 0 && !fixedUeId) {
      fetch("/api/ues", { cache: "no-store" })
        .then((res) => (res.ok ? res.json() : null))
        .then((data: { ues?: UEOption[] } | null) => {
          if (data?.ues) setAllUes(data.ues);
        })
        .catch(() => {});
    }
  }, [allDocs.length, allUes.length, fixedUeId]);

  const fetchQuizzes = useCallback(async () => {
    try {
      const url = fixedUeId
        ? `/api/quizzes?ueId=${encodeURIComponent(fixedUeId)}`
        : "/api/quizzes";
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { quizzes?: CommunityQuizSummary[] };
      setQuizzes(data.quizzes || []);
    } finally {
      setLoadingList(false);
    }
  }, [fixedUeId]);

  useEffect(() => {
    void fetchQuizzes();
  }, [fetchQuizzes]);

  function addDraftQuestion(type: CustomQuestionType) {
    const base: CustomQuizQuestion =
      type === "IMAGE_OCCLUSION"
        ? {
            id: `cq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: "IMAGE_OCCLUSION",
            prompt: "Légendez chaque zone masquée sur ce schéma :",
            imageDataUrl: "",
            masks: [],
            showWordBank: true,
          }
        : type === "FILL_BLANK"
        ? {
            id: `cq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type: "FILL_BLANK",
            prompt: "Complétez l'énoncé :",
            sentenceWithBlank: "",
            correctAnswer: "",
          }
        : {
            id: `cq-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            type,
            prompt: "",
            options: ["", "", "", ""],
            correctIndices: type === "QCU" ? [0] : [0, 1],
          };
    setDraftQuestions((prev) => [...prev, base]);
  }

  function updateDraftQuestion(
    id: string,
    patch: Partial<CustomQuizQuestion>
  ) {
    setDraftQuestions((prev) =>
      prev.map((q) => (q.id === id ? { ...q, ...patch } : q))
    );
  }

  function removeDraftQuestion(id: string) {
    setDraftQuestions((prev) => prev.filter((q) => q.id !== id));
  }

  async function handleSaveQuiz(e: React.FormEvent) {
    e.preventDefault();
    setEditorError(null);

    if (!quizTitle.trim()) {
      setEditorError("Donnez un titre à votre test.");
      return;
    }

    for (let i = 0; i < draftQuestions.length; i += 1) {
      const q = draftQuestions[i];
      if (q.type === "IMAGE_OCCLUSION") {
        if (!q.imageDataUrl) {
          setEditorError(
            `Question ${i + 1} (Image à légender) : sélectionnez ou capturez une image.`
          );
          return;
        }
        if (!q.masks || q.masks.length === 0) {
          setEditorError(
            `Question ${i + 1} : tracez au moins un cache sur l'image.`
          );
          return;
        }
        if (q.masks.some((m) => !m.label.trim())) {
          setEditorError(
            `Question ${i + 1} : renseignez la légende attendue pour chaque cache.`
          );
          return;
        }
      } else if (q.type === "FILL_BLANK") {
        if (!q.sentenceWithBlank?.trim() || !q.correctAnswer?.trim()) {
          setEditorError(
            `Question ${i + 1} (Texte à trou) : renseignez la phrase et le mot attendu.`
          );
          return;
        }
      } else {
        if (
          !q.prompt.trim() ||
          !q.options ||
          q.options.some((o) => !o.trim()) ||
          !q.correctIndices ||
          q.correctIndices.length === 0
        ) {
          setEditorError(
            `Question ${i + 1} (${q.type}) : renseignez l'énoncé, les 4 choix et au moins une bonne réponse.`
          );
          return;
        }
      }
    }

    setSavingQuiz(true);
    try {
      const res = await fetch("/api/quizzes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: quizTitle.trim(),
          description: quizDescription.trim(),
          ueId: fixedUeId || quizUeId || null,
          isPublic: quizPublic,
          questions: draftQuestions,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setEditorError(data.error || "Impossible d'enregistrer ce test.");
        return;
      }

      setEditorOpen(false);
      setQuizTitle("");
      setQuizDescription("");
      setDraftQuestions([
        {
          id: `cq-${Date.now()}`,
          type: "IMAGE_OCCLUSION",
          prompt: "Légendez chaque zone masquée sur ce schéma de cours :",
          imageDataUrl: "",
          masks: [],
          showWordBank: true,
        },
      ]);
      await fetchQuizzes();
    } finally {
      setSavingQuiz(false);
    }
  }

  async function handleUpvote(quizId: string) {
    const res = await fetch(`/api/quizzes/${quizId}/upvote`, {
      method: "POST",
    });
    if (res.ok) {
      await fetchQuizzes();
    }
  }

  async function handleTogglePin(quiz: CommunityQuizSummary) {
    const res = await fetch(`/api/quizzes/${quiz.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isPinned: !quiz.isPinned }),
    });
    if (res.ok) {
      await fetchQuizzes();
    }
  }

  async function handleDeleteQuiz(quizId: string) {
    if (!confirm("Supprimer ce test ?")) return;
    const res = await fetch(`/api/quizzes/${quizId}`, { method: "DELETE" });
    if (res.ok) {
      if (activeQuiz?.id === quizId) setActiveQuiz(null);
      await fetchQuizzes();
    }
  }

  async function handleLaunchQuiz(quizId: string) {
    const res = await fetch(`/api/quizzes/${quizId}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { quiz: LoadedQuizDetail };
    setActiveQuiz(data.quiz);
    setPlayerAnswers({});
    setPlayerSubmitted(false);
    setFocusedMaskId(null);
    setRevealedOcclusion({});
  }

  async function handleSubmitQuizAttempt() {
    if (!activeQuiz || playerSubmitted) return;
    setPlayerSubmitted(true);
    await fetch(`/api/quizzes/${activeQuiz.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "RECORD_ATTEMPT" }),
    });
    await fetchQuizzes();
  }

  function gradeQuestion(q: CustomQuizQuestion): {
    passed: boolean;
    detailScore: number;
    detailTotal: number;
  } {
    const ans = playerAnswers[q.id];
    if (q.type === "IMAGE_OCCLUSION") {
      const masks = q.masks || [];
      const map =
        ans && typeof ans === "object" && !Array.isArray(ans)
          ? (ans as Record<string, string>)
          : {};
      let ok = 0;
      for (const m of masks) {
        if (
          normalizeQuizText(map[m.id] || "") ===
          normalizeQuizText(m.label || "")
        ) {
          ok += 1;
        }
      }
      return {
        passed: masks.length > 0 && ok === masks.length,
        detailScore: ok,
        detailTotal: masks.length,
      };
    }

    if (q.type === "FILL_BLANK") {
      const given = typeof ans === "string" ? normalizeQuizText(ans) : "";
      const expected = normalizeQuizText(q.correctAnswer || "");
      const ok = Boolean(expected && given === expected);
      return { passed: ok, detailScore: ok ? 1 : 0, detailTotal: 1 };
    }

    const sel = Array.isArray(ans) ? [...ans].sort((a, b) => a - b) : [];
    const exp = [...(q.correctIndices || [])].sort((a, b) => a - b);
    const ok =
      exp.length > 0 &&
      sel.length === exp.length &&
      sel.every((v, idx) => v === exp[idx]);
    return { passed: ok, detailScore: ok ? 1 : 0, detailTotal: 1 };
  }

  return (
    <div className="space-y-4">
      {/* Header Strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 border border-border bg-card p-4">
        <div>
          <h2 className="font-mono text-xs font-bold uppercase tracking-wider text-ink">
            TESTS SUR MESURE &amp; IMAGES À LÉGENDER (PARTAGE PROMO + UPVOTES ▲)
          </h2>
          <p className="mt-1 text-xs text-stone">
            Créez des schémas à légender en masquant les légendes d&apos;un
            PDF, des QCM/QCU ou des textes à trous et partagez-les à la
            promotion.
          </p>
        </div>

        <button
          type="button"
          onClick={() => setEditorOpen((p) => !p)}
          className="inline-flex items-center gap-1.5 border border-ink bg-ink px-4 py-2 font-mono text-xs uppercase tracking-wider text-card hover:bg-ink/90"
        >
          {editorOpen ? (
            <>
              <X className="h-3.5 w-3.5" />
              <span>FERMER L&apos;ÉDITEUR</span>
            </>
          ) : (
            <>
              <Plus className="h-3.5 w-3.5" />
              <span>CRÉER UN TEST / IMAGE À LÉGENDER</span>
            </>
          )}
        </button>
      </div>

      {/* Custom Quiz Builder */}
      {editorOpen && (
        <form
          onSubmit={handleSaveQuiz}
          className="space-y-5 border border-ink bg-card p-5"
          style={{ borderTop: "3px solid #C83E4D" }}
        >
          <div className="flex items-center justify-between border-b border-border pb-3">
            <span className="font-mono text-xs font-bold uppercase tracking-wider text-ink">
              ÉDITEUR DE TEST COMPLEXE &amp; OCCLUSION D&apos;IMAGE
            </span>
          </div>

          {editorError && (
            <div className="border border-carmine/40 bg-carmine/10 px-3 py-2 font-mono text-xs text-carmine">
              {editorError}
            </div>
          )}

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                TITRE DU TEST
              </label>
              <input
                type="text"
                required
                value={quizTitle}
                onChange={(e) => setQuizTitle(e.target.value)}
                placeholder="Ex : Anatomie cœur — Schéma à légender"
                className="w-full border border-border bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
              />
            </div>

            {!fixedUeId && (
              <div>
                <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                  UE ASSOCIÉE
                </label>
                <select
                  value={quizUeId}
                  onChange={(e) => setQuizUeId(e.target.value)}
                  className="w-full border border-border bg-paper px-3 py-2 font-mono text-xs uppercase text-ink focus:border-ink focus:outline-none"
                >
                  <option value="">TRANSVERSAL / PROMO</option>
                  {allUes.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.code} — {u.title}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
                PARTAGE PROMOTION
              </label>
              <select
                value={quizPublic ? "PUBLIC" : "PRIVATE"}
                onChange={(e) => setQuizPublic(e.target.value === "PUBLIC")}
                className="w-full border border-border bg-paper px-3 py-2 font-mono text-xs uppercase text-ink focus:border-ink focus:outline-none"
              >
                <option value="PUBLIC">PUBLIC (PARTAGÉ + UPVOTES)</option>
                <option value="PRIVATE">PRIVÉ (BROUILLON PERSONNEL)</option>
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-wider text-stone">
              DESCRIPTION / CONSIGNES (OPTIONNEL)
            </label>
            <input
              type="text"
              value={quizDescription}
              onChange={(e) => setQuizDescription(e.target.value)}
              placeholder="Précisions sur les chapitres couverts..."
              className="w-full border border-border bg-paper px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
            />
          </div>

          {/* Draft Questions */}
          <div className="space-y-4">
            {draftQuestions.map((q, idx) => (
              <div key={q.id} className="border border-border bg-paper p-4">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
                  <span className="font-mono text-xs font-bold uppercase tracking-wider text-ink">
                    QUESTION {idx + 1} ·{" "}
                    {q.type === "IMAGE_OCCLUSION"
                      ? "IMAGE À LÉGENDER (CACHES)"
                      : q.type}
                  </span>
                  {draftQuestions.length > 1 && (
                    <button
                      type="button"
                      onClick={() => removeDraftQuestion(q.id)}
                      className="inline-flex items-center gap-1 font-mono text-[10px] uppercase text-stone hover:text-carmine"
                    >
                      <Trash2 className="h-3 w-3" />
                      <span>RETIRER</span>
                    </button>
                  )}
                </div>

                <input
                  type="text"
                  value={q.prompt}
                  onChange={(e) =>
                    updateDraftQuestion(q.id, { prompt: e.target.value })
                  }
                  placeholder="Consigne / énoncé de la question..."
                  className="mb-3 w-full border border-border bg-card px-3 py-2 text-sm text-ink focus:border-ink focus:outline-none"
                />

                {q.type === "IMAGE_OCCLUSION" && (
                  <div className="space-y-3">
                    <ImageOcclusionEditor
                      documents={allDocs}
                      imageDataUrl={q.imageDataUrl || ""}
                      masks={q.masks || []}
                      sourceDocId={q.sourceDocId}
                      sourcePageNumber={q.sourcePageNumber}
                      onChange={(next) =>
                        updateDraftQuestion(q.id, {
                          imageDataUrl: next.imageDataUrl,
                          masks: next.masks,
                          sourceDocId: next.sourceDocId,
                          sourcePageNumber: next.sourcePageNumber,
                        })
                      }
                    />
                    <label className="inline-flex cursor-pointer items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-ink">
                      <input
                        type="checkbox"
                        checked={Boolean(q.showWordBank)}
                        onChange={(e) =>
                          updateDraftQuestion(q.id, {
                            showWordBank: e.target.checked,
                          })
                        }
                        className="accent-ink"
                      />
                      <span>
                        PROPOSER LES LÉGENDES MÉLANGÉES EN AIDE VISUELLE
                      </span>
                    </label>
                  </div>
                )}

                {(q.type === "QCU" || q.type === "QCM") && (
                  <div className="space-y-2">
                    {(q.options || ["", "", "", ""]).map((opt, optIdx) => {
                      const isCorrect =
                        q.correctIndices?.includes(optIdx) ?? false;
                      return (
                        <div key={optIdx} className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              if (q.type === "QCU") {
                                updateDraftQuestion(q.id, {
                                  correctIndices: [optIdx],
                                });
                              } else {
                                const curr = q.correctIndices || [];
                                const next = isCorrect
                                  ? curr.filter((x) => x !== optIdx)
                                  : [...curr, optIdx];
                                updateDraftQuestion(q.id, {
                                  correctIndices: next,
                                });
                              }
                            }}
                            className={`flex h-8 w-8 shrink-0 items-center justify-center border font-mono text-xs font-bold ${
                              isCorrect
                                ? "border-forest bg-forest text-card"
                                : "border-border bg-card text-stone"
                            }`}
                            title="Marquer comme bonne réponse"
                          >
                            {isCorrect ? "✓" : String.fromCharCode(65 + optIdx)}
                          </button>
                          <input
                            type="text"
                            value={opt}
                            onChange={(e) => {
                              const nextOpts = [
                                ...(q.options || ["", "", "", ""]),
                              ];
                              nextOpts[optIdx] = e.target.value;
                              updateDraftQuestion(q.id, { options: nextOpts });
                            }}
                            placeholder={`Choix ${String.fromCharCode(
                              65 + optIdx
                            )}...`}
                            className="flex-1 border border-border bg-card px-3 py-1.5 text-xs text-ink focus:border-ink focus:outline-none"
                          />
                        </div>
                      );
                    })}
                  </div>
                )}

                {q.type === "FILL_BLANK" && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <input
                      type="text"
                      value={q.sentenceWithBlank || ""}
                      onChange={(e) =>
                        updateDraftQuestion(q.id, {
                          sentenceWithBlank: e.target.value,
                        })
                      }
                      placeholder="Phrase avec [ ______ ] à la place du mot..."
                      className="border border-border bg-card px-3 py-2 text-xs text-ink"
                    />
                    <input
                      type="text"
                      value={q.correctAnswer || ""}
                      onChange={(e) =>
                        updateDraftQuestion(q.id, {
                          correctAnswer: e.target.value,
                        })
                      }
                      placeholder="Mot exact attendu..."
                      className="border border-border bg-card px-3 py-2 font-mono text-xs text-ink"
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Add Question Buttons */}
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => addDraftQuestion("IMAGE_OCCLUSION")}
                className="inline-flex items-center gap-1 border border-ink bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:bg-pinned"
              >
                <ImageIcon className="h-3 w-3" />
                <span>+ IMAGE À LÉGENDER</span>
              </button>
              <button
                type="button"
                onClick={() => addDraftQuestion("QCU")}
                className="border border-border bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink"
              >
                + QCU
              </button>
              <button
                type="button"
                onClick={() => addDraftQuestion("QCM")}
                className="border border-border bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink"
              >
                + QCM
              </button>
              <button
                type="button"
                onClick={() => addDraftQuestion("FILL_BLANK")}
                className="border border-border bg-paper px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink"
              >
                + PHRASE À TROU
              </button>
            </div>

            <button
              type="submit"
              disabled={savingQuiz}
              className="inline-flex items-center gap-2 border border-ink bg-ink px-5 py-2.5 font-mono text-xs uppercase tracking-wider text-card hover:bg-ink/90 disabled:opacity-50"
            >
              {savingQuiz && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              <span>PUBLIER LE TEST</span>
            </button>
          </div>
        </form>
      )}

      {/* Active Quiz Interactive Player */}
      {activeQuiz && (
        <div
          className="border border-ink bg-card"
          style={{ borderTop: "3px solid #3B7A57" }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-ink px-4 py-3 text-card">
            <div>
              <p className="font-mono text-xs font-bold uppercase tracking-wider">
                PASSATION DU TEST · {activeQuiz.title}
              </p>
              <p className="font-mono text-[10px] uppercase tracking-wider text-card/75">
                PAR {activeQuiz.author.name} · {activeQuiz.questions.length}{" "}
                QUESTIONS
              </p>
            </div>
            <button
              type="button"
              onClick={() => setActiveQuiz(null)}
              className="border border-card/30 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-card hover:bg-carmine"
            >
              QUITTER
            </button>
          </div>

          <div className="space-y-5 p-5">
            {activeQuiz.questions.map((q, qIdx) => {
              const graded = playerSubmitted ? gradeQuestion(q) : null;
              const isRevealed = Boolean(revealedOcclusion[q.id]);

              return (
                <article
                  key={q.id}
                  className={`border p-4 ${
                    graded
                      ? graded.passed
                        ? "border-forest bg-forest/5"
                        : "border-carmine bg-carmine/5"
                      : "border-border bg-paper"
                  }`}
                >
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <span className="bg-badge-bg px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-badge-text">
                      Q{qIdx + 1} ·{" "}
                      {q.type === "IMAGE_OCCLUSION"
                        ? "IMAGE À LÉGENDER"
                        : q.type}
                    </span>

                    {q.type === "IMAGE_OCCLUSION" && playerSubmitted && (
                      <button
                        type="button"
                        onClick={() =>
                          setRevealedOcclusion((p) => ({
                            ...p,
                            [q.id]: !p[q.id],
                          }))
                        }
                        className="inline-flex items-center gap-1 border border-border bg-card px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-ink hover:border-ink"
                      >
                        {isRevealed ? (
                          <>
                            <EyeOff className="h-3 w-3" />
                            <span>REMETTRE LES CACHES</span>
                          </>
                        ) : (
                          <>
                            <Eye className="h-3 w-3" />
                            <span>RÉVÉLER LES LÉGENDES SOUS LES CACHES</span>
                          </>
                        )}
                      </button>
                    )}
                  </div>

                  <p className="mb-3 text-sm font-semibold text-ink">
                    {q.prompt}
                  </p>

                  {q.type === "IMAGE_OCCLUSION" && q.imageDataUrl && (
                    <div className="space-y-4">
                      <div className="flex justify-center overflow-auto border border-border bg-[#ECEAE3] p-2">
                        <div className="relative inline-block max-w-full border border-ink bg-white">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={q.imageDataUrl}
                            alt="Schéma à légender"
                            className="block max-h-[540px] w-auto max-w-full"
                          />
                          {(q.masks || []).map((m) => {
                            const ansMap =
                              (playerAnswers[q.id] as Record<string, string>) ||
                              {};
                            const typed = ansMap[m.id] || "";
                            const maskOk =
                              playerSubmitted &&
                              normalizeQuizText(typed) ===
                                normalizeQuizText(m.label);

                            return (
                              <button
                                key={m.id}
                                type="button"
                                onClick={() => setFocusedMaskId(m.id)}
                                style={{
                                  left: `${m.xPercent}%`,
                                  top: `${m.yPercent}%`,
                                  width: `${m.wPercent}%`,
                                  height: `${m.hPercent}%`,
                                }}
                                className={`absolute flex items-center justify-center border-2 font-mono text-xs font-bold transition-opacity ${
                                  isRevealed
                                    ? "border-forest bg-transparent text-transparent"
                                    : playerSubmitted
                                    ? maskOk
                                      ? "border-forest bg-forest text-card"
                                      : "border-carmine bg-carmine text-card"
                                    : focusedMaskId === m.id
                                    ? "border-amber bg-ink text-amber"
                                    : "border-amber bg-ink text-card"
                                }`}
                              >
                                {!isRevealed && `#${m.index}`}
                              </button>
                            );
                          })}
                        </div>
                      </div>

                      {/* Word bank hints if enabled */}
                      {q.showWordBank && !playerSubmitted && (
                        <div className="flex flex-wrap items-center gap-1.5 border border-border bg-card p-2.5">
                          <span className="font-mono text-[10px] uppercase tracking-wider text-stone">
                            BANQUE DE LÉGENDES :
                          </span>
                          {[...(q.masks || [])]
                            .map((m) => m.label)
                            .sort()
                            .map((lbl, li) => (
                              <button
                                key={li}
                                type="button"
                                onClick={() => {
                                  const targetMask =
                                    (q.masks || []).find(
                                      (m) => m.id === focusedMaskId
                                    ) ||
                                    (q.masks || []).find(
                                      (m) =>
                                        !(
                                          (playerAnswers[q.id] as Record<
                                            string,
                                            string
                                          >) || {}
                                        )[m.id]
                                    );
                                  if (!targetMask) return;
                                  const currentMap =
                                    (playerAnswers[q.id] as Record<
                                      string,
                                      string
                                    >) || {};
                                  setPlayerAnswers((p) => ({
                                    ...p,
                                    [q.id]: {
                                      ...currentMap,
                                      [targetMask.id]: lbl,
                                    },
                                  }));
                                }}
                                className="border border-border bg-paper px-2 py-0.5 font-mono text-[11px] text-ink hover:border-ink"
                              >
                                {lbl}
                              </button>
                            ))}
                        </div>
                      )}

                      {/* Numbered Legend Inputs */}
                      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                        {(q.masks || []).map((m) => {
                          const currentMap =
                            (playerAnswers[q.id] as Record<string, string>) ||
                            {};
                          const val = currentMap[m.id] || "";
                          const ok =
                            playerSubmitted &&
                            normalizeQuizText(val) ===
                              normalizeQuizText(m.label);

                          return (
                            <div
                              key={m.id}
                              className={`flex items-center gap-2 border p-2 ${
                                playerSubmitted
                                  ? ok
                                    ? "border-forest bg-forest/10"
                                    : "border-carmine bg-carmine/10"
                                  : focusedMaskId === m.id
                                  ? "border-ink bg-pinned"
                                  : "border-border bg-card"
                              }`}
                            >
                              <span className="flex h-6 w-8 shrink-0 items-center justify-center border border-ink bg-ink font-mono text-xs font-bold text-card">
                                #{m.index}
                              </span>
                              <div className="min-w-0 flex-1">
                                <input
                                  type="text"
                                  disabled={playerSubmitted}
                                  value={val}
                                  onFocus={() => setFocusedMaskId(m.id)}
                                  onChange={(e) =>
                                    setPlayerAnswers((p) => ({
                                      ...p,
                                      [q.id]: {
                                        ...((p[q.id] as Record<
                                          string,
                                          string
                                        >) || {}),
                                        [m.id]: e.target.value,
                                      },
                                    }))
                                  }
                                  placeholder={`Légende #${m.index}...`}
                                  className="w-full border border-border bg-paper px-2.5 py-1 text-xs text-ink focus:border-ink focus:outline-none disabled:opacity-80"
                                />
                                {playerSubmitted && !ok && (
                                  <p className="mt-1 font-mono text-[10px] font-bold text-forest">
                                    Attendu : {m.label}
                                  </p>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {(q.type === "QCU" || q.type === "QCM") && q.options && (
                    <div className="space-y-1.5">
                      {q.options.map((opt, optIdx) => {
                        const sel = Array.isArray(playerAnswers[q.id])
                          ? (playerAnswers[q.id] as number[])
                          : [];
                        const active = sel.includes(optIdx);
                        const exp = q.correctIndices?.includes(optIdx);
                        return (
                          <button
                            key={optIdx}
                            type="button"
                            disabled={playerSubmitted}
                            onClick={() => {
                              if (q.type === "QCU") {
                                setPlayerAnswers((p) => ({
                                  ...p,
                                  [q.id]: [optIdx],
                                }));
                              } else {
                                const next = active
                                  ? sel.filter((x) => x !== optIdx)
                                  : [...sel, optIdx];
                                setPlayerAnswers((p) => ({
                                  ...p,
                                  [q.id]: next,
                                }));
                              }
                            }}
                            className={`flex w-full items-start gap-2.5 border px-3 py-2 text-left text-xs ${
                              playerSubmitted && exp
                                ? "border-forest bg-forest/10"
                                : playerSubmitted && active && !exp
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
                      <p className="border border-border bg-card p-3 text-xs text-ink">
                        {q.sentenceWithBlank}
                      </p>
                      <input
                        type="text"
                        disabled={playerSubmitted}
                        value={
                          typeof playerAnswers[q.id] === "string"
                            ? (playerAnswers[q.id] as string)
                            : ""
                        }
                        onChange={(e) =>
                          setPlayerAnswers((p) => ({
                            ...p,
                            [q.id]: e.target.value,
                          }))
                        }
                        placeholder="Votre réponse..."
                        className="w-full border border-border bg-card px-3 py-2 font-mono text-xs text-ink"
                      />
                      {playerSubmitted && (
                        <p className="font-mono text-[11px] text-forest">
                          Réponse attendue : {q.correctAnswer}
                        </p>
                      )}
                    </div>
                  )}

                  {graded && (
                    <div className="mt-3 flex items-center gap-1.5 border-t border-border pt-2 font-mono text-[11px]">
                      {graded.passed ? (
                        <Check className="h-3.5 w-3.5 text-forest" />
                      ) : (
                        <XCircle className="h-3.5 w-3.5 text-carmine" />
                      )}
                      <span>
                        RÉSULTAT : {graded.detailScore} / {graded.detailTotal}
                      </span>
                    </div>
                  )}
                </article>
              );
            })}

            <div className="flex justify-end gap-2">
              {playerSubmitted ? (
                <button
                  type="button"
                  onClick={() => {
                    setPlayerAnswers({});
                    setPlayerSubmitted(false);
                    setRevealedOcclusion({});
                  }}
                  className="border border-border bg-paper px-4 py-2 font-mono text-xs uppercase tracking-wider text-ink hover:border-ink"
                >
                  RECOMMENCER CE TEST
                </button>
              ) : (
                <button
                  type="button"
                  onClick={handleSubmitQuizAttempt}
                  className="border border-ink bg-ink px-5 py-2.5 font-mono text-xs uppercase tracking-wider text-card hover:bg-ink/90"
                >
                  VALIDER ET CORRIGER LE TEST
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Community Quizzes List with Upvotes */}
      {loadingList ? (
        <div className="border border-border bg-card p-6 font-mono text-xs uppercase tracking-wider text-stone">
          CHARGEMENT DES TESTS PARTAGÉS...
        </div>
      ) : quizzes.length === 0 ? (
        <div className="border border-border bg-card p-8 text-center">
          <p className="font-mono text-xs font-bold uppercase tracking-wider text-ink">
            AUCUN TEST PARTAGÉ POUR L&apos;INSTANT
          </p>
          <p className="mt-1 text-sm text-stone">
            Soyez le premier à créer un schéma à légender ou un quiz pour
            votre promotion !
          </p>
        </div>
      ) : (
        <div className="divide-y divide-border border border-border bg-card">
          {quizzes.map((q) => {
            const isAuthor = q.authorId === session?.user?.id;
            const isAdmin = session?.user?.globalRole === "YEAR_ADMIN";
            const canPin = canManageFixedUe || isAdmin;
            const canDelete = isAuthor || canPin;

            return (
              <div
                key={q.id}
                className={`flex flex-wrap items-center justify-between gap-3 p-4 ${
                  q.isPinned ? "bg-pinned" : "bg-card"
                }`}
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  {/* Upvote Button */}
                  <button
                    type="button"
                    onClick={() => handleUpvote(q.id)}
                    className={`flex w-12 shrink-0 flex-col items-center justify-center border py-1.5 font-mono text-xs transition-colors ${
                      q.hasUpvoted
                        ? "border-ink bg-ink text-card"
                        : "border-border bg-paper text-ink hover:border-ink"
                    }`}
                    title="Voter pour ce test"
                  >
                    <ArrowUp className="h-3.5 w-3.5" />
                    <span className="text-[11px] font-bold">
                      {q.upvoteCount}
                    </span>
                  </button>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-sm font-bold text-ink">{q.title}</h3>
                      {q.ue && (
                        <span className="border border-border bg-paper px-1.5 py-0.5 font-mono text-[10px] uppercase text-ink">
                          {q.ue.code}
                        </span>
                      )}
                      {q.hasOcclusion && (
                        <span className="bg-badge-bg px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-badge-text">
                          IMAGE À LÉGENDER
                        </span>
                      )}
                      {q.isPinned && (
                        <span className="bg-badge-bg px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-badge-text">
                          VALIDÉ PAR RESP. UE
                        </span>
                      )}
                      {!q.isPublic && (
                        <span className="border border-border bg-paper px-1.5 py-0.5 font-mono text-[10px] uppercase text-stone">
                          PRIVÉ
                        </span>
                      )}
                    </div>
                    {q.description && (
                      <p className="mt-1 text-xs text-stone">{q.description}</p>
                    )}
                    <p className="mt-1 font-mono text-[10px] uppercase tracking-wider text-stone">
                      PAR {q.author.name} · {q.questionCount} QUESTION(S) ·{" "}
                      {q.attemptsCount} PASSATION(S)
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => handleLaunchQuiz(q.id)}
                    className="inline-flex items-center gap-1.5 border border-ink bg-ink px-3.5 py-2 font-mono text-[11px] uppercase tracking-wider text-card hover:bg-ink/90"
                  >
                    <Play className="h-3 w-3" />
                    <span>LANCER</span>
                  </button>

                  {canPin && (
                    <button
                      type="button"
                      onClick={() => handleTogglePin(q)}
                      title={
                        q.isPinned
                          ? "Retirer l'épinglage"
                          : "Valider / Épingler par Resp. UE"
                      }
                      className={`border p-2 ${
                        q.isPinned
                          ? "border-badge-text bg-badge-bg text-badge-text"
                          : "border-border bg-paper text-stone hover:text-ink"
                      }`}
                    >
                      {q.isPinned ? (
                        <PinOff className="h-3.5 w-3.5" />
                      ) : (
                        <Pin className="h-3.5 w-3.5" />
                      )}
                    </button>
                  )}

                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => handleDeleteQuiz(q.id)}
                      title="Supprimer ce test"
                      className="border border-border bg-paper p-2 text-stone hover:border-carmine hover:text-carmine"
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
  );
}
