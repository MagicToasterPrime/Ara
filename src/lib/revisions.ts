import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { checkOllamaHealth, getOllamaConfig } from "@/lib/ollama";
import { getAllUeMetaMap } from "@/lib/ue-meta";
import { getUserAccountMeta } from "@/lib/user-schema";

export type QuestionType =
  | "QCU"
  | "QCM"
  | "QROC"
  | "FLASHCARD"
  | "FILL_BLANK"
  | "IMAGE_POINT";

export interface RevisionQuestion {
  id: string;
  type: QuestionType;
  ueId: string;
  ueCode: string;
  ueTitle: string;
  chapterId?: string;
  chapterTitle: string;
  documentId: string;
  documentTitle: string;
  fileName: string;
  pageNumber: number;
  prompt: string;
  explanation: string;
  generatedByAi?: boolean;
  // QCU / QCM
  options?: string[];
  correctIndices?: number[];
  // QROC & FILL_BLANK
  sentenceWithBlank?: string;
  correctAnswer?: string;
  acceptedKeywords?: string[];
  wordBank?: string[];
  // FLASHCARD
  flashcardBack?: string;
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
  | string // QROC / FLASHCARD ("KNOWN" | "REVIEW") / FILL_BLANK
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
    chapterId: chunk.chapterId,
    chapterTitle: chunk.chapterTitle,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    fileName: chunk.fileName,
    pageNumber: chunk.pageNumber,
    prompt: `Parmi les propositions suivantes concernant « ${chunk.chapterTitle} » (${chunk.ueCode}), laquelle est directement tirée du cours ?`,
    options: tagged.map((t) => t.text),
    correctIndices: [correctIndex >= 0 ? correctIndex : 0],
    explanation: `Passage exact issu de ${chunk.documentTitle} (page ${chunk.pageNumber}) : « ${correctSentence} ».`,
    generatedByAi: false,
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
    chapterId: chunk.chapterId,
    chapterTitle: chunk.chapterTitle,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    fileName: chunk.fileName,
    pageNumber: chunk.pageNumber,
    prompt: `Cochez TOUTES les affirmations exactes issues du chapitre « ${chunk.chapterTitle} » (${chunk.ueCode}) :`,
    options: tagged.map((t) => t.text),
    correctIndices,
    explanation: `Les deux énoncés exacts proviennent de ${chunk.documentTitle} (page ${chunk.pageNumber}).`,
    generatedByAi: false,
  };
}

function buildFallbackQROC(chunk: SampledChunk): RevisionQuestion {
  const sentences = splitSentences(chunk.content);
  const chosenSentence =
    sentences.find((s) => extractCandidateTerms(s).length > 0) ||
    sentences[0] ||
    chunk.content.slice(0, 220).trim();

  const sortedTerms = [
    ...extractCandidateTerms(chosenSentence),
    ...extractCandidateTerms(chunk.content),
  ].sort((a, b) => b.length - a.length);

  const uniqueTerms = Array.from(new Set(sortedTerms));
  const targetTerm = uniqueTerms[0] || chunk.chapterTitle;
  const acceptedKeywords =
    uniqueTerms.length > 0 ? uniqueTerms.slice(0, 5) : [targetTerm];

  const escaped = targetTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const maskedContext = chosenSentence.replace(
    new RegExp(`\\b${escaped}\\b`, "i"),
    "[ ... ]"
  );

  const prompt =
    maskedContext !== chosenSentence
      ? `Question ouverte (QROC) — Dans « ${chunk.chapterTitle} » (${chunk.ueCode}), quel terme clé complète exactement l'énoncé : « ${maskedContext} » ?`
      : `Question ouverte (QROC) — Citez un terme ou mécanisme essentiel de « ${chunk.chapterTitle} » abordé dans « ${chunk.documentTitle} » (page ${chunk.pageNumber}).`;

  return {
    id: `q-${crypto.randomUUID().slice(0, 8)}`,
    type: "QROC",
    ueId: chunk.ueId,
    ueCode: chunk.ueCode,
    ueTitle: chunk.ueTitle,
    chapterId: chunk.chapterId,
    chapterTitle: chunk.chapterTitle,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    fileName: chunk.fileName,
    pageNumber: chunk.pageNumber,
    prompt,
    correctAnswer: targetTerm,
    acceptedKeywords,
    explanation: `Réponse attendue : « ${targetTerm} ». Passage de ${chunk.documentTitle} (page ${chunk.pageNumber}) : « ${chosenSentence} ».`,
    generatedByAi: false,
  };
}

function buildFallbackFlashcard(chunk: SampledChunk): RevisionQuestion {
  const sentences = splitSentences(chunk.content);
  const terms = extractCandidateTerms(chunk.content).sort(
    (a, b) => b.length - a.length
  );
  const topTerm = terms[0] || chunk.chapterTitle;
  const summary =
    sentences.slice(0, 2).join(" ") || chunk.content.slice(0, 280).trim();

  return {
    id: `q-${crypto.randomUUID().slice(0, 8)}`,
    type: "FLASHCARD",
    ueId: chunk.ueId,
    ueCode: chunk.ueCode,
    ueTitle: chunk.ueTitle,
    chapterId: chunk.chapterId,
    chapterTitle: chunk.chapterTitle,
    documentId: chunk.documentId,
    documentTitle: chunk.documentTitle,
    fileName: chunk.fileName,
    pageNumber: chunk.pageNumber,
    prompt: `Que faut-il retenir à propos de « ${topTerm} » dans « ${chunk.chapterTitle} » (${chunk.ueCode}) ?`,
    flashcardBack: summary,
    explanation: `Synthèse issue de ${chunk.documentTitle} (page ${chunk.pageNumber}).`,
    generatedByAi: false,
  };
}

function parseOllamaJson<T>(raw: string): T | null {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return null;
    }
  }
}

async function tryOllamaQuizEnrichment(
  qcuChunk: SampledChunk,
  qcmChunk: SampledChunk,
  qrocChunk: SampledChunk,
  flashcardChunk: SampledChunk
): Promise<{
  qcu?: Partial<RevisionQuestion>;
  qcm?: Partial<RevisionQuestion>;
  qroc?: Partial<RevisionQuestion>;
  flashcard?: Partial<RevisionQuestion>;
} | null> {
  const health = await checkOllamaHealth();
  if (!health.online) return null;

  const { host, model } = getOllamaConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);

  const prompt = `Tu es Spix, assistant pédagogique universitaire vétérinaire. Génère strictement un objet JSON valide avec 4 exercices de révision en français basés EXCLUSIVEMENT sur ces 4 extraits de cours :

EXTRAIT 1 (pour QCU — 1 seule bonne réponse parmi 4) [${qcuChunk.ueCode} - ${qcuChunk.chapterTitle} - ${qcuChunk.documentTitle}]:
${qcuChunk.content.slice(0, 900)}

EXTRAIT 2 (pour QCM — 2 ou 3 bonnes réponses parmi 4) [${qcmChunk.ueCode} - ${qcmChunk.chapterTitle} - ${qcmChunk.documentTitle}]:
${qcmChunk.content.slice(0, 900)}

EXTRAIT 3 (pour QROC — Question à Réponse Ouverte et Courte, réponse précise en 1 à 5 mots) [${qrocChunk.ueCode} - ${qrocChunk.chapterTitle} - ${qrocChunk.documentTitle}]:
${qrocChunk.content.slice(0, 900)}

EXTRAIT 4 (pour FLASHCARD — carte Recto question / Verso synthèse claire) [${flashcardChunk.ueCode} - ${flashcardChunk.chapterTitle} - ${flashcardChunk.documentTitle}]:
${flashcardChunk.content.slice(0, 900)}

Format JSON strict attendu :
{
  "qcu": {
    "prompt": "Question précise à choix unique ?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctIndices": [0],
    "explanation": "Explication courte tirée du cours."
  },
  "qcm": {
    "prompt": "Question à choix multiples ?",
    "options": ["Option 1", "Option 2", "Option 3", "Option 4"],
    "correctIndices": [0, 2],
    "explanation": "Explication courte tirée du cours."
  },
  "qroc": {
    "prompt": "Question ouverte courte appelant une notion précise ?",
    "correctAnswer": "Réponse courte attendue",
    "acceptedKeywords": ["motcle1", "motcle2"],
    "explanation": "Explication courte tirée du cours."
  },
  "flashcard": {
    "prompt": "Question ou concept clé à restituer (Recto) ?",
    "flashcardBack": "Réponse synthétique et structurée tirée du cours (Verso, 1 à 3 phrases).",
    "explanation": "Point clé à mémoriser."
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

    const parsed = parseOllamaJson<{
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
      qroc?: {
        prompt?: string;
        correctAnswer?: string;
        acceptedKeywords?: string[];
        explanation?: string;
      };
      flashcard?: {
        prompt?: string;
        flashcardBack?: string;
        explanation?: string;
      };
    }>(data.response);

    if (!parsed) return null;

    const result: {
      qcu?: Partial<RevisionQuestion>;
      qcm?: Partial<RevisionQuestion>;
      qroc?: Partial<RevisionQuestion>;
      flashcard?: Partial<RevisionQuestion>;
    } = {};

    if (
      parsed.qcu?.prompt &&
      Array.isArray(parsed.qcu.options) &&
      parsed.qcu.options.length === 4 &&
      Array.isArray(parsed.qcu.correctIndices) &&
      parsed.qcu.correctIndices.length === 1 &&
      parsed.qcu.correctIndices[0] >= 0 &&
      parsed.qcu.correctIndices[0] < 4
    ) {
      result.qcu = {
        prompt: parsed.qcu.prompt.trim(),
        options: parsed.qcu.options.map((o) => String(o).trim()),
        correctIndices: parsed.qcu.correctIndices,
        explanation: (parsed.qcu.explanation || "").trim(),
        generatedByAi: true,
      };
    }

    if (
      parsed.qcm?.prompt &&
      Array.isArray(parsed.qcm.options) &&
      parsed.qcm.options.length === 4 &&
      Array.isArray(parsed.qcm.correctIndices)
    ) {
      const validIndices = Array.from(
        new Set(
          parsed.qcm.correctIndices.filter(
            (i) => typeof i === "number" && i >= 0 && i < 4
          )
        )
      ).sort((a, b) => a - b);

      if (validIndices.length >= 2) {
        result.qcm = {
          prompt: parsed.qcm.prompt.trim(),
          options: parsed.qcm.options.map((o) => String(o).trim()),
          correctIndices: validIndices,
          explanation: (parsed.qcm.explanation || "").trim(),
          generatedByAi: true,
        };
      }
    }

    if (
      parsed.qroc?.prompt &&
      typeof parsed.qroc.correctAnswer === "string" &&
      parsed.qroc.correctAnswer.trim().length > 0
    ) {
      const mainAnswer = parsed.qroc.correctAnswer.trim();
      const rawKeywords = Array.isArray(parsed.qroc.acceptedKeywords)
        ? parsed.qroc.acceptedKeywords
            .map((k) => String(k).trim())
            .filter((k) => k.length > 0)
        : [];
      const keywordSet = Array.from(new Set([mainAnswer, ...rawKeywords]));

      result.qroc = {
        prompt: parsed.qroc.prompt.trim(),
        correctAnswer: mainAnswer,
        acceptedKeywords: keywordSet,
        explanation: (parsed.qroc.explanation || "").trim(),
        generatedByAi: true,
      };
    }

    if (
      parsed.flashcard?.prompt &&
      typeof parsed.flashcard.flashcardBack === "string" &&
      parsed.flashcard.flashcardBack.trim().length > 0
    ) {
      result.flashcard = {
        prompt: parsed.flashcard.prompt.trim(),
        flashcardBack: parsed.flashcard.flashcardBack.trim(),
        explanation: (parsed.flashcard.explanation || "").trim(),
        generatedByAi: true,
      };
    }

    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function generateQuizQuestions(options?: {
  userId?: string;
  ueId?: string;
  count?: number;
}): Promise<RevisionQuestion[]> {
  const requestedCount = Math.max(4, Math.min(20, options?.count || 4));

  let targetUeId = options?.ueId?.trim() || "";

  if (!targetUeId) {
    const uesWithChunks = await prisma.uE.findMany({
      where: {
        chapters: {
          some: {
            documents: {
              some: {
                chunks: { some: {} },
              },
            },
          },
        },
      },
      select: { id: true },
    });

    if (uesWithChunks.length === 0) {
      return [];
    }

    let candidateUeIds = uesWithChunks.map((u) => u.id);

    if (options?.userId) {
      try {
        const [userMeta, ueMetaMap] = await Promise.all([
          getUserAccountMeta(options.userId),
          getAllUeMetaMap(),
        ]);
        const classMatched = candidateUeIds.filter(
          (id) => ueMetaMap.get(id)?.classLevel === userMeta.classLevel
        );
        if (classMatched.length > 0) {
          candidateUeIds = classMatched;
        }
      } catch {
        // Fallback safely across all available UEs
      }
    }

    targetUeId =
      candidateUeIds[Math.floor(Math.random() * candidateUeIds.length)];
  }

  // Pick random chunks distributed evenly across randomly shuffled courses inside the chosen UE
  const chunkRefs = await prisma.documentChunk.findMany({
    where: {
      document: {
        chapter: {
          ueId: targetUeId,
        },
      },
    },
    select: { id: true, documentId: true },
  });

  if (chunkRefs.length === 0) {
    return [];
  }

  const byDoc = new Map<string, string[]>();
  for (const ref of chunkRefs) {
    const existing = byDoc.get(ref.documentId);
    if (existing) existing.push(ref.id);
    else byDoc.set(ref.documentId, [ref.id]);
  }

  const shuffledDocQueues = shuffle(
    Array.from(byDoc.values()).map((ids) => shuffle(ids))
  );

  const pickedIds: string[] = [];
  const maxSample = 48;
  let depth = 0;
  while (pickedIds.length < maxSample) {
    let added = false;
    for (const queue of shuffledDocQueues) {
      if (depth < queue.length) {
        pickedIds.push(queue[depth]);
        added = true;
        if (pickedIds.length >= maxSample) break;
      }
    }
    if (!added) break;
    depth += 1;
  }

  const rawChunks = await prisma.documentChunk.findMany({
    where: { id: { in: pickedIds } },
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

  const baseList: SampledChunk[] =
    mapped.length > 0
      ? mapped
      : rawChunks.map((c) => ({
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
        }));

  const pool = shuffle(baseList);

  // Pick chunks from varied random documents & chapters within the selected UE
  const selected: SampledChunk[] = [];
  const usedDocs = new Set<string>();
  const usedChapters = new Set<string>();

  for (const item of pool) {
    if (!usedDocs.has(item.documentId) && !usedChapters.has(item.chapterId)) {
      usedDocs.add(item.documentId);
      usedChapters.add(item.chapterId);
      selected.push(item);
    }
    if (selected.length >= requestedCount) break;
  }
  if (selected.length < requestedCount) {
    for (const item of pool) {
      if (!usedDocs.has(item.documentId)) {
        usedDocs.add(item.documentId);
        selected.push(item);
      }
      if (selected.length >= requestedCount) break;
    }
  }
  let fallbackCursor = 0;
  while (selected.length < requestedCount) {
    selected.push(pool[fallbackCursor % pool.length]);
    fallbackCursor += 1;
  }

  const questions: RevisionQuestion[] = [];
  const batchCount = Math.ceil(requestedCount / 4);

  for (let b = 0; b < batchCount; b += 1) {
    const c1 = selected[b * 4] || pool[0];
    const c2 = selected[b * 4 + 1] || pool[1 % pool.length];
    const c3 = selected[b * 4 + 2] || pool[2 % pool.length];
    const c4 = selected[b * 4 + 3] || pool[3 % pool.length];

    const fallbackQcu = buildFallbackQCU(c1, pool);
    const fallbackQcm = buildFallbackQCM(c2, pool);
    const fallbackQroc = buildFallbackQROC(c3);
    const fallbackFlashcard = buildFallbackFlashcard(c4);

    const aiEnriched =
      b < 2 ? await tryOllamaQuizEnrichment(c1, c2, c3, c4) : null;

    questions.push(
      aiEnriched?.qcu ? { ...fallbackQcu, ...aiEnriched.qcu } : fallbackQcu,
      aiEnriched?.qcm ? { ...fallbackQcm, ...aiEnriched.qcm } : fallbackQcm,
      aiEnriched?.qroc
        ? { ...fallbackQroc, ...aiEnriched.qroc }
        : fallbackQroc,
      aiEnriched?.flashcard
        ? { ...fallbackFlashcard, ...aiEnriched.flashcard }
        : fallbackFlashcard
    );
  }

  return questions.slice(0, requestedCount);
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
    } else if (q.type === "QROC") {
      const given = typeof ans === "string" ? normalizeTextForMatch(ans) : "";
      if (given.length >= 2) {
        const expected = q.correctAnswer
          ? normalizeTextForMatch(q.correctAnswer)
          : "";
        const matchesMain = Boolean(
          expected &&
            (given === expected ||
              (expected.length >= 3 && given.includes(expected)) ||
              (given.length >= 4 && expected.includes(given)))
        );
        const keywords = (q.acceptedKeywords || [])
          .map((k) => normalizeTextForMatch(k))
          .filter((k) => k.length >= 3);
        const matchesKeyword = keywords.some(
          (kw) =>
            given === kw ||
            given.includes(kw) ||
            (given.length >= 4 && kw.includes(given))
        );
        correct = matchesMain || matchesKeyword;
      }
    } else if (q.type === "FLASHCARD") {
      correct = ans === "KNOWN";
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
