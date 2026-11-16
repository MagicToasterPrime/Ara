import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { checkOllamaHealth, getOllamaConfig } from "@/lib/ollama";

export type QuestionType = "QCU" | "QCM" | "FILL_BLANK" | "IMAGE_POINT";

export interface RevisionQuestion {
  id: string;
  type: QuestionType;
  ueId: string;
  ueCode: string;
  ueTitle: string;
  chapterTitle: string;
  documentId: string;
  documentTitle: string;
  fileName: string;
  pageNumber: number;
  prompt: string;
  explanation: string;
  // QCU / QCM
  options?: string[];
  correctIndices?: number[];
  // FILL_BLANK
  sentenceWithBlank?: string;
  correctAnswer?: string;
  wordBank?: string[];
  // IMAGE_POINT
  targetPhrase?: string;
  fallbackZones?: Array<{
    id: string;
    label: string;
    xPercent: number;
    yPercent: number;
  }>;
  correctZoneId?: string;
}

export interface ImagePointAnswer {
  xPercent: number;
  yPercent: number;
  matchedTarget: boolean;
  selectedZoneId?: string;
}

export type RevisionAnswerValue =
  | number[] // QCU / QCM
  | string // FILL_BLANK
  | ImagePointAnswer; // IMAGE_POINT

let schemaEnsured = false;

export async function ensureRevisionSchema() {
  if (schemaEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "revisionEnabled" BOOLEAN NOT NULL DEFAULT false;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "currentStreak" INTEGER NOT NULL DEFAULT 0;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bestStreak" INTEGER NOT NULL DEFAULT 0;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastRevisionDate" TEXT;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totalRevisionPoints" INTEGER NOT NULL DEFAULT 0;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "DailyRevisionSession" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "dateKey" TEXT NOT NULL,
        "questionsJson" TEXT NOT NULL,
        "answersJson" TEXT NOT NULL DEFAULT '{}',
        "score" INTEGER NOT NULL DEFAULT 0,
        "totalQuestions" INTEGER NOT NULL DEFAULT 0,
        "completed" BOOLEAN NOT NULL DEFAULT false,
        "completedAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "DailyRevisionSession_pkey" PRIMARY KEY ("id")
      );
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "DailyRevisionSession_userId_dateKey_key"
      ON "DailyRevisionSession"("userId", "dateKey");
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "DailyRevisionSession_userId_createdAt_idx"
      ON "DailyRevisionSession"("userId", "createdAt");
    `);
    schemaEnsured = true;
  } catch (err) {
    console.warn("[Revisions] Schema check warning:", err);
  }
}

export function getLocalDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getYesterdayDateKey(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return getLocalDateKey(d);
}

export function computeEffectiveStreak(
  storedStreak: number,
  lastRevisionDate: string | null
): number {
  if (!lastRevisionDate || storedStreak <= 0) return 0;
  const today = getLocalDateKey();
  const yesterday = getYesterdayDateKey();
  if (lastRevisionDate === today || lastRevisionDate === yesterday) {
    return storedStreak;
  }
  return 0;
}

function shuffle<T>(arr: T[]): T[] {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

export function normalizeTextForMatch(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ");
}

interface SampledChunk {
  id: string;
  content: string;
  pageNumber: number;
  documentId: string;
  documentTitle: string;
  fileName: string;
  chapterId: string;
  chapterTitle: string;
  ueId: string;
  ueCode: string;
  ueTitle: string;
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 35 && s.length <= 260);
}

function extractCandidateTerms(text: string): string[] {
  const stopWords = new Set([
    "dans",
    "pour",
    "avec",
    "sans",
    "chez",
    "cette",
    "celui",
    "celle",
    "entre",
    "ainsi",
    "alors",
    "comme",
    "donc",
    "mais",
    "plus",
    "moins",
    "tres",
    "tout",
    "tous",
    "toute",
    "toutes",
    "etre",
    "avoir",
    "faire",
    "peut",
    "sont",
    "etat",
    "lors",
    "sous",
    "vers",
    "dont",
    "elles",
    "nous",
    "vous",
    "leur",
    "leurs",
    "chapitre",
    "cours",
    "page",
  ]);

  const words = text
    .replace(/[.,;:!?()[\]"'«»]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 6 && /^[a-zA-ZÀ-ÿ-]+$/.test(w))
    .filter((w) => !stopWords.has(normalizeTextForMatch(w)));

  return Array.from(new Set(words));
}

function buildFallbackQCU(
  chunk: SampledChunk,
  otherChunks: SampledChunk[]
): RevisionQuestion {
  const sentences = splitSentences(chunk.content);
  const correctSentence =
    sentences[0] || chunk.content.slice(0, 180).trim();

  const distractors: string[] = [];
  for (const other of otherChunks) {
    if (other.id === chunk.id) continue;
    const sents = splitSentences(other.content);
    if (sents[0] && sents[0] !== correctSentence) {
      distractors.push(sents[0]);
    }
    if (distractors.length >= 3) break;
  }

  while (distractors.length < 3) {
    distractors.push(
      `Cette affirmation ne figure pas dans la section « ${chunk.chapterTitle} » (page ${chunk.pageNumber}).`
    );
  }

  const tagged = shuffle([
    { text: correctSentence, isCorrect: true },
    ...distractors.slice(0, 3).map((d) => ({ text: d, isCorrect: false })),
  ]);

  const correctIndex = tagged.findIndex((t) => t.isCorrect);

  return {
    id: `q-${crypto.randomUUID().slice(0, 8)}`,
    type: "QCU",
    ueId: chunk.ueId,
    ueCode: chunk.ueCode,
    ueTitle: chunk.ueTitle,
    chapterTitle: chunk.chapterTitle,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    fileName: chunk.fileName,
    pageNumber: chunk.pageNumber,
    prompt: `Parmi les propositions suivantes concernant « ${chunk.chapterTitle} » (${chunk.ueCode}), laquelle est directement tirée du cours ?`,
    options: tagged.map((t) => t.text),
    correctIndices: [correctIndex >= 0 ? correctIndex : 0],
    explanation: `Passage exact issu de ${chunk.documentTitle} (page ${chunk.pageNumber}) : « ${correctSentence} ».`,
  };
}

function buildFallbackQCM(
  chunk: SampledChunk,
  otherChunks: SampledChunk[]
): RevisionQuestion {
  const sentences = splitSentences(chunk.content);
  const correctA = sentences[0] || chunk.content.slice(0, 150).trim();
  const correctB =
    sentences[1] ||
    `Élément traité dans ${chunk.documentTitle} (p.${chunk.pageNumber}) : ${chunk.content
      .slice(-140)
      .trim()}`;

  const distractors: string[] = [];
  for (const other of otherChunks) {
    if (other.ueId !== chunk.ueId || other.id !== chunk.id) {
      const sents = splitSentences(other.content);
      if (sents[0] && sents[0] !== correctA && sents[0] !== correctB) {
        distractors.push(sents[0]);
      }
    }
    if (distractors.length >= 2) break;
  }

  while (distractors.length < 2) {
    distractors.push(
      `Notion hors périmètre pour la page ${chunk.pageNumber} de ${chunk.documentTitle}.`
    );
  }

  const tagged = shuffle([
    { text: correctA, isCorrect: true },
    { text: correctB, isCorrect: true },
    { text: distractors[0], isCorrect: false },
    { text: distractors[1], isCorrect: false },
  ]);

  const correctIndices = tagged
    .map((item, idx) => (item.isCorrect ? idx : -1))
    .filter((idx) => idx !== -1);

  return {
    id: `q-${crypto.randomUUID().slice(0, 8)}`,
    type: "QCM",
    ueId: chunk.ueId,
    ueCode: chunk.ueCode,
    ueTitle: chunk.ueTitle,
    chapterTitle: chunk.chapterTitle,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    fileName: chunk.fileName,
    pageNumber: chunk.pageNumber,
    prompt: `Cochez TOUTES les affirmations exactes issues du chapitre « ${chunk.chapterTitle} » (${chunk.ueCode}) :`,
    options: tagged.map((t) => t.text),
    correctIndices,
    explanation: `Les deux énoncés exacts proviennent de ${chunk.documentTitle} (page ${chunk.pageNumber}).`,
  };
}

function buildFallbackFillBlank(
  chunk: SampledChunk,
  otherChunks: SampledChunk[]
): RevisionQuestion {
  const sentences = splitSentences(chunk.content);
  const chosenSentence =
    sentences.find((s) => extractCandidateTerms(s).length > 0) ||
    sentences[0] ||
    chunk.content.slice(0, 200);

  const terms = extractCandidateTerms(chosenSentence);
  const targetTerm =
    terms.sort((a, b) => b.length - a.length)[0] ||
    extractCandidateTerms(chunk.content)[0] ||
    chunk.ueCode;

  const escaped = targetTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const blanked = chosenSentence.replace(
    new RegExp(`\\b${escaped}\\b`, "i"),
    "[ ______ ]"
  );

  const sentenceWithBlank =
    blanked !== chosenSentence
      ? blanked
      : `${chosenSentence} (Mot-clé principal : [ ______ ])`;

  const allOtherTerms = shuffle(
    otherChunks.flatMap((c) => extractCandidateTerms(c.content))
  ).filter(
    (t) => normalizeTextForMatch(t) !== normalizeTextForMatch(targetTerm)
  );

  const bankSet = new Set<string>([targetTerm]);
  for (const t of allOtherTerms) {
    if (bankSet.size >= 4) break;
    bankSet.add(t);
  }
  while (bankSet.size < 4) {
    bankSet.add(`Terme_${bankSet.size + 1}`);
  }

  return {
    id: `q-${crypto.randomUUID().slice(0, 8)}`,
    type: "FILL_BLANK",
    ueId: chunk.ueId,
    ueCode: chunk.ueCode,
    ueTitle: chunk.ueTitle,
    chapterTitle: chunk.chapterTitle,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    fileName: chunk.fileName,
    pageNumber: chunk.pageNumber,
    prompt: `Complétez l'extrait du cours « ${chunk.documentTitle} » (${chunk.ueCode}) :`,
    sentenceWithBlank,
    correctAnswer: targetTerm,
    wordBank: shuffle(Array.from(bankSet)),
    explanation: `Le terme exact dans le cours (page ${chunk.pageNumber}) est « ${targetTerm} ».`,
  };
}

function buildImagePointQuestion(chunk: SampledChunk): RevisionQuestion {
  const terms = extractCandidateTerms(chunk.content).sort(
    (a, b) => b.length - a.length
  );
  const targetPhrase = terms[0] || chunk.content.split(/\s+/).slice(0, 3).join(" ");

  const fallbackZones = [
    { id: "Z1", label: "A", xPercent: 28, yPercent: 28 },
    { id: "Z2", label: "B", xPercent: 72, yPercent: 28 },
    { id: "Z3", label: "C", xPercent: 28, yPercent: 70 },
    { id: "Z4", label: "D", xPercent: 72, yPercent: 70 },
  ];

  const correctZone = fallbackZones[Math.floor(Math.random() * fallbackZones.length)];

  return {
    id: `q-${crypto.randomUUID().slice(0, 8)}`,
    type: "IMAGE_POINT",
    ueId: chunk.ueId,
    ueCode: chunk.ueCode,
    ueTitle: chunk.ueTitle,
    chapterTitle: chunk.chapterTitle,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    fileName: chunk.fileName,
    pageNumber: chunk.pageNumber,
    prompt: `Pointez directement sur l'image du cours (${chunk.fileName}, p.${chunk.pageNumber}) l'emplacement correspondant à la notion : « ${targetPhrase} »`,
    targetPhrase,
    fallbackZones,
    correctZoneId: correctZone.id,
    explanation: `La notion « ${targetPhrase} » apparaît sur la page ${chunk.pageNumber} de ${chunk.documentTitle}.`,
  };
}

async function tryOllamaQuizEnrichment(
  qcuChunk: SampledChunk,
  qcmChunk: SampledChunk,
  fillChunk: SampledChunk
): Promise<{
  qcu?: Partial<RevisionQuestion>;
  qcm?: Partial<RevisionQuestion>;
  fillBlank?: Partial<RevisionQuestion>;
} | null> {
  const health = await checkOllamaHealth();
  if (!health.online) return null;

  const { host, model } = getOllamaConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14000);

  const prompt = `Génère strictement un JSON valide avec 3 questions de révision universitaire en français basées uniquement sur ces 3 extraits de cours :

EXTRAIT 1 (pour QCU - 1 seule bonne réponse parmi 4) [${qcuChunk.ueCode} - ${qcuChunk.chapterTitle}]:
${qcuChunk.content}

EXTRAIT 2 (pour QCM - exactement 2 bonnes réponses parmi 4) [${qcmChunk.ueCode} - ${qcmChunk.chapterTitle}]:
${qcmChunk.content}

EXTRAIT 3 (pour FILL_BLANK - phrase à trou avec [ ______ ]) [${fillChunk.ueCode} - ${fillChunk.chapterTitle}]:
${fillChunk.content}

Format JSON exact attendu :
{
  "qcu": {
    "prompt": "Question précise ?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctIndices": [0],
    "explanation": "Explication courte."
  },
  "qcm": {
    "prompt": "Question à choix multiples ?",
    "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
    "correctIndices": [0, 2],
    "explanation": "Explication courte."
  },
  "fillBlank": {
    "prompt": "Complétez la notion clé :",
    "sentenceWithBlank": "Phrase du cours avec [ ______ ] à la place du terme clé.",
    "correctAnswer": "mot",
    "distractors": ["faux1", "faux2", "faux3"],
    "explanation": "Explication courte."
  }
}`;

  try {
    const res = await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        format: "json",
        stream: false,
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { response?: string };
    if (!data.response) return null;

    const parsed = JSON.parse(data.response) as {
      qcu?: {
        prompt?: string;
        options?: string[];
        correctIndices?: number[];
        explanation?: string;
      };
      qcm?: {
        prompt?: string;
        options?: string[];
        correctIndices?: number[];
        explanation?: string;
      };
      fillBlank?: {
        prompt?: string;
        sentenceWithBlank?: string;
        correctAnswer?: string;
        distractors?: string[];
        explanation?: string;
      };
    };

    const result: {
      qcu?: Partial<RevisionQuestion>;
      qcm?: Partial<RevisionQuestion>;
      fillBlank?: Partial<RevisionQuestion>;
    } = {};

    if (
      parsed.qcu?.prompt &&
      Array.isArray(parsed.qcu.options) &&
      parsed.qcu.options.length === 4 &&
      Array.isArray(parsed.qcu.correctIndices) &&
      parsed.qcu.correctIndices.length === 1
    ) {
      result.qcu = {
        prompt: parsed.qcu.prompt,
        options: parsed.qcu.options,
        correctIndices: parsed.qcu.correctIndices,
        explanation: parsed.qcu.explanation || "",
      };
    }

    if (
      parsed.qcm?.prompt &&
      Array.isArray(parsed.qcm.options) &&
      parsed.qcm.options.length === 4 &&
      Array.isArray(parsed.qcm.correctIndices) &&
      parsed.qcm.correctIndices.length >= 2
    ) {
      result.qcm = {
        prompt: parsed.qcm.prompt,
        options: parsed.qcm.options,
        correctIndices: parsed.qcm.correctIndices,
        explanation: parsed.qcm.explanation || "",
      };
    }

    if (
      parsed.fillBlank?.sentenceWithBlank &&
      parsed.fillBlank.sentenceWithBlank.includes("______") &&
      parsed.fillBlank.correctAnswer
    ) {
      const distractors = Array.isArray(parsed.fillBlank.distractors)
        ? parsed.fillBlank.distractors.slice(0, 3)
        : [];
      result.fillBlank = {
        prompt: parsed.fillBlank.prompt || "Complétez la phrase du cours :",
        sentenceWithBlank: parsed.fillBlank.sentenceWithBlank,
        correctAnswer: parsed.fillBlank.correctAnswer.trim(),
        wordBank: shuffle([
          parsed.fillBlank.correctAnswer.trim(),
          ...distractors,
        ]),
        explanation: parsed.fillBlank.explanation || "",
      };
    }

    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function generateQuizQuestions(): Promise<RevisionQuestion[]> {
  const rawChunks = await prisma.documentChunk.findMany({
    take: 80,
    include: {
      document: {
        select: {
          id: true,
          title: true,
          fileName: true,
          chapter: {
            select: {
              id: true,
              title: true,
              ue: {
                select: { id: true, code: true, title: true },
              },
            },
          },
        },
      },
    },
  });

  if (rawChunks.length === 0) {
    return [];
  }

  const mapped: SampledChunk[] = rawChunks
    .filter((c) => c.content.trim().length >= 40)
    .map((c) => ({
      id: c.id,
      content: c.content.trim(),
      pageNumber: c.pageNumber,
      documentId: c.document.id,
      documentTitle: c.document.title,
      fileName: c.document.fileName,
      chapterId: c.document.chapter.id,
      chapterTitle: c.document.chapter.title,
      ueId: c.document.chapter.ue.id,
      ueCode: c.document.chapter.ue.code,
      ueTitle: c.document.chapter.ue.title,
    }));

  const pool = shuffle(mapped.length > 0 ? mapped : rawChunks.map((c) => ({
    id: c.id,
    content: c.content.trim() || c.document.title,
    pageNumber: c.pageNumber,
    documentId: c.document.id,
    documentTitle: c.document.title,
    fileName: c.document.fileName,
    chapterId: c.document.chapter.id,
    chapterTitle: c.document.chapter.title,
    ueId: c.document.chapter.ue.id,
    ueCode: c.document.chapter.ue.code,
    ueTitle: c.document.chapter.ue.title,
  })));

  // Prefer distinct chapters across UEs
  const selected: SampledChunk[] = [];
  const usedChapters = new Set<string>();
  for (const item of pool) {
    if (!usedChapters.has(item.chapterId)) {
      usedChapters.add(item.chapterId);
      selected.push(item);
    }
    if (selected.length >= 4) break;
  }
  while (selected.length < 4) {
    selected.push(pool[selected.length % pool.length]);
  }

  const [c1, c2, c3, c4] = selected;

  const fallbackQcu = buildFallbackQCU(c1, pool);
  const fallbackQcm = buildFallbackQCM(c2, pool);
  const fallbackFill = buildFallbackFillBlank(c3, pool);
  const imagePointQ = buildImagePointQuestion(c4);

  const aiEnriched = await tryOllamaQuizEnrichment(c1, c2, c3);

  const qcuQuestion: RevisionQuestion = aiEnriched?.qcu
    ? {
        ...fallbackQcu,
        ...aiEnriched.qcu,
      }
    : fallbackQcu;

  const qcmQuestion: RevisionQuestion = aiEnriched?.qcm
    ? {
        ...fallbackQcm,
        ...aiEnriched.qcm,
      }
    : fallbackQCMQuestionFix(fallbackQcm);

  const fillQuestion: RevisionQuestion = aiEnriched?.fillBlank
    ? {
        ...fallbackFill,
        ...aiEnriched.fillBlank,
        wordBank:
          aiEnriched.fillBlank.wordBank &&
          aiEnriched.fillBlank.wordBank.length >= 2
            ? aiEnriched.fillBlank.wordBank
            : fallbackFill.wordBank,
      }
    : fallbackFill;

  return [qcuQuestion, qcmQuestion, fillQuestion, imagePointQ];
}

function fallbackQCMQuestionFix(q: RevisionQuestion): RevisionQuestion {
  return q;
}

export function gradeRevisionAnswers(
  questions: RevisionQuestion[],
  answers: Record<string, RevisionAnswerValue>
): { score: number; results: Record<string, boolean> } {
  let score = 0;
  const results: Record<string, boolean> = {};

  for (const q of questions) {
    const ans = answers[q.id];
    let correct = false;

    if (q.type === "QCU" || q.type === "QCM") {
      const selected = Array.isArray(ans)
        ? [...ans].sort((a, b) => a - b)
        : [];
      const expected = [...(q.correctIndices || [])].sort((a, b) => a - b);
      correct =
        expected.length > 0 &&
        selected.length === expected.length &&
        selected.every((v, idx) => v === expected[idx]);
    } else if (q.type === "FILL_BLANK") {
      const given = typeof ans === "string" ? normalizeTextForMatch(ans) : "";
      const expected = q.correctAnswer
        ? normalizeTextForMatch(q.correctAnswer)
        : "";
      correct = Boolean(expected && given === expected);
    } else if (q.type === "IMAGE_POINT") {
      if (ans && typeof ans === "object" && !Array.isArray(ans)) {
        if (ans.matchedTarget) {
          correct = true;
        } else if (ans.selectedZoneId && q.correctZoneId) {
          correct = ans.selectedZoneId === q.correctZoneId;
        }
      }
    }

    results[q.id] = correct;
    if (correct) score += 1;
  }

  return { score, results };
}
