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
    const sharedTableCheck = await prisma.$queryRaw<Array<{ reg: string | null }>>`
      SELECT to_regclass('"SharedDailyQuiz"')::text AS reg
    `;
    const isFirstSharedSetup = !sharedTableCheck[0]?.reg;

    await prisma.$executeRawUnsafe(`
      ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "revisionEnabled" BOOLEAN NOT NULL DEFAULT true;
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "User" ALTER COLUMN "revisionEnabled" SET DEFAULT true;
    `);
    if (isFirstSharedSetup) {
      await prisma.$executeRawUnsafe(`
        UPDATE "User" SET "revisionEnabled" = true WHERE "revisionEnabled" = false;
      `);
    }
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
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "SharedDailyQuiz" (
        "dateKey" TEXT NOT NULL,
        "ueId" TEXT,
        "ueCode" TEXT,
        "ueTitle" TEXT,
        "questionsJson" TEXT NOT NULL,
        "totalQuestions" INTEGER NOT NULL DEFAULT 0,
        "generatedByAi" BOOLEAN NOT NULL DEFAULT false,
        "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "SharedDailyQuiz_pkey" PRIMARY KEY ("dateKey")
      );
    `);
    schemaEnsured = true;
  } catch (err) {
    console.warn("[Revisions] Schema check warning:", err);
  }
}

/**
 * Daily quiz boundary shifts at 06:00 AM local time so nightly generation runs
 * at 06:00 and late-night students (00:00–05:59) can still finish yesterday's quiz.
 */
export function getLocalDateKey(date = new Date()): string {
  const shifted = new Date(date.getTime() - 6 * 60 * 60 * 1000);
  const year = shifted.getFullYear();
  const month = String(shifted.getMonth() + 1).padStart(2, "0");
  const day = String(shifted.getDate()).padStart(2, "0");
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

export interface FactChunkLike {
  content: string;
  pageNumber: number;
  documentId: string;
  documentTitle: string;
  fileName: string;
  chapterTitle: string;
  ueId: string;
  ueCode: string;
  ueTitle: string;
}

export function cleanChunkTextForAi(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\uFFFD/g, "")
    .replace(/([a-zA-ZÀ-ÿ])-\s*\n\s*([a-zA-ZÀ-ÿ])/g, "$1$2")
    .replace(/^==(?:Start|End) of (?:OCR|PDF).*==$/gim, " ")
    .replace(/\[REP[ÈE]RE VISUEL[^\]]*\]/gi, " ")
    .replace(/\bPage\s+\d+(?:\s*\/\s*\d+)?\b/gi, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitCleanSentences(text: string): string[] {
  const cleaned = cleanChunkTextForAi(text).replace(/\n+/g, " ");
  return cleaned
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25 && s.length <= 320);
}

export function selectHighValueText(raw: string, maxChars = 650): string {
  const cleaned = cleanChunkTextForAi(raw);
  if (cleaned.length <= maxChars) return cleaned;

  const units = cleaned
    .split(/(?<=[.!?])\s+|\n+/)
    .map((u) => u.trim())
    .filter((u) => u.length >= 12);

  if (units.length === 0) return cleaned.slice(0, maxChars);

  const scored = units.map((unit, idx) => {
    let score = 0;
    if (
      /\d+\s*(?:%|µm|um|mm|cm|m|ml|dl|l|mg|g|kg|mmol|ui|j|h|ans|mois|semaines|°c)/i.test(
        unit
      ) ||
      /\b(?:1[5-9]\d{2}|20[0-2]\d)\b/.test(unit)
    ) {
      score += 4;
    }
    if (
      /[:=]|désigne|signifie|vient de|dérivé|permet|provoque|entraîne|induit|inhibe|active|obligatoire|essentiel|attention|règle/i.test(
        unit
      )
    ) {
      score += 3;
    }
    if (unit.length >= 45 && unit.length <= 210) {
      score += 1;
    }
    if (/^(?:sommaire|table des matières|exporté le|généré par|fin\b)/i.test(unit)) {
      score -= 5;
    }
    return { unit, idx, score };
  });

  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);

  const picked: Array<{ idx: number; unit: string }> = [];
  let total = 0;
  for (const item of scored) {
    const addLen = item.unit.length + 1;
    if (total + addLen > maxChars && picked.length > 0) continue;
    picked.push({ idx: item.idx, unit: item.unit });
    total += addLen;
    if (total >= maxChars) break;
  }

  picked.sort((a, b) => a.idx - b.idx);
  return picked.map((p) => p.unit).join(" ").slice(0, maxChars);
}

export function recoverJsonArrayItems<Item>(
  raw: string,
  arrayKey: string
): Item[] {
  const keyMatch = new RegExp(`"${arrayKey}"\\s*:\\s*\\[`, "i").exec(raw);
  if (!keyMatch) return [];

  const startIdx = keyMatch.index + keyMatch[0].length;
  const items: Item[] = [];
  let inString = false;
  let escaped = false;
  let depth = 0;
  let objStart = -1;

  for (let i = startIdx; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      continue;
    }

    if (ch === "{") {
      if (depth === 0) {
        objStart = i;
      }
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0 && objStart !== -1) {
        const slice = raw.slice(objStart, i + 1);
        try {
          items.push(JSON.parse(slice) as Item);
        } catch {
          // Ignore malformed partial object
        }
        objStart = -1;
      }
    } else if (ch === "]" && depth === 0) {
      break;
    }
  }

  return items;
}

export function parseOllamaJsonWithRecovery<T>(
  raw: string,
  arrayKeys: string[] = []
): T | null {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  try {
    return JSON.parse(stripped) as T;
  } catch {
    const match = stripped.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]) as T;
      } catch {
        // Continue to partial array recovery
      }
    }
  }

  for (const key of arrayKeys) {
    const items = recoverJsonArrayItems<unknown>(stripped, key);
    if (items.length > 0) {
      return { [key]: items } as T;
    }
  }

  return null;
}

export function shuffleOptionsWithIndices(
  options: string[],
  correctIndices: number[]
): { options: string[]; correctIndices: number[] } {
  const paired = options.map((text, idx) => ({
    text: String(text).trim(),
    isCorrect: correctIndices.includes(idx),
  }));
  const mixed = shuffle(paired);
  const nextIndices = mixed
    .map((p, idx) => (p.isCorrect ? idx : -1))
    .filter((idx) => idx >= 0);

  return {
    options: mixed.map((p) => p.text),
    correctIndices: nextIndices.length > 0 ? nextIndices : [0],
  };
}

export function isLowQualityExcerptQuestion(
  prompt: string,
  options?: string[]
): boolean {
  if (
    /correspond exactement au cours|directement tir[eé]e du cours|quelle phrase figure dans le cours|notion cl[eé].*quel [eé]l[eé]ment/i.test(
      prompt
    )
  ) {
    return true;
  }
  if (!options || options.length === 0) return false;

  let longOptionCount = 0;
  for (const opt of options) {
    const clean = opt.trim();
    if (
      /hors p[eé]rim[eè]tre|ne figure pas dans|assertion contradictoire|affirmation invers[eé]e|n'est pas abord[eé]e/i.test(
        clean
      )
    ) {
      return true;
    }
    if (clean.length > 135) {
      longOptionCount += 1;
    }
  }

  return longOptionCount >= 2;
}

export interface ExtractedDefinitionFact {
  term: string;
  explanation: string;
  chunk: FactChunkLike;
}

export interface ExtractedQuantFact {
  subject: string;
  exactValue: string;
  options: string[];
  correctIndex: number;
  contextSentence: string;
  chunk: FactChunkLike;
}

function buildNumericDistractors(
  exactValue: string,
  unitSuffix: string,
  numValue: number,
  isPercent: boolean,
  isYear: boolean
): { options: string[]; correctIndex: number } {
  const shuffleFirst = (opts: string[]) => {
    const res = shuffleOptionsWithIndices(opts, [0]);
    return { options: res.options, correctIndex: res.correctIndices[0] ?? 0 };
  };

  if (isYear) {
    const offsets = [-45, -18, 22, 54];
    const picked = offsets
      .slice(0, 3)
      .map((d) => String(Math.min(2025, Math.max(1500, Math.round(numValue + d)))));
    const unique = Array.from(new Set([exactValue, ...picked])).slice(0, 4);
    while (unique.length < 4) {
      unique.push(String(Math.round(numValue + unique.length * 15)));
    }
    return shuffleFirst(unique);
  }

  if (isPercent) {
    const candidates: string[] = [];
    if (numValue >= 85) {
      candidates.push("Moins de 5%", "Environ 20 à 30%", "Exactement 50%");
    } else if (numValue >= 60) {
      candidates.push("Moins de 15%", "Environ 30 à 40%", "Près de 95%");
    } else if (numValue >= 35) {
      candidates.push("Moins de 10%", "Environ 20%", "Plus de 85%");
    } else {
      candidates.push("Environ 45 à 55%", "Plus de 80%", "Moins de 1%");
    }
    const cleanExact = exactValue.trim();
    const pool = [cleanExact, ...candidates.filter((c) => c.toLowerCase() !== cleanExact.toLowerCase())].slice(0, 4);
    return shuffleFirst(pool);
  }

  const formatNum = (val: number) =>
    val >= 100
      ? Math.round(val).toLocaleString("fr-FR")
      : Number.isInteger(val)
      ? String(val)
      : val.toFixed(1).replace(".", ",");
  const suffix = unitSuffix ? ` ${unitSuffix}` : "";
  const factors = numValue > 10 ? [0.25, 0.5, 2.5] : [0.4, 2, 4];
  const distractors = factors.map(
    (f) => `${formatNum(Math.max(0.5, numValue * f))}${suffix}`
  );
  const all = Array.from(new Set([exactValue.trim(), ...distractors])).slice(0, 4);
  while (all.length < 4) {
    all.push(`${formatNum(numValue + all.length * 3)}${suffix}`);
  }
  return shuffleFirst(all);
}

export function extractCourseFacts(chunks: FactChunkLike[]): {
  definitions: ExtractedDefinitionFact[];
  quantFacts: ExtractedQuantFact[];
} {
  const definitions: ExtractedDefinitionFact[] = [];
  const quantFacts: ExtractedQuantFact[] = [];
  const seenTerms = new Set<string>();
  const seenQuants = new Set<string>();

  for (const chunk of chunks) {
    const cleaned = cleanChunkTextForAi(chunk.content);
    const lines = cleaned.split(/\n+|(?<=[.!?])\s+/);

    for (const rawLine of lines) {
      const line = rawLine.replace(/^[•\-*\d.)\s]+/, "").trim();
      if (line.length < 18 || line.length > 260) continue;

      // 1. Definition / colon patterns: "Terme : explication..."
      const colonMatch = line.match(/^([^:()]{3,48})\s*:\s*(.{16,180})$/);
      if (colonMatch) {
        const term = colonMatch[1].replace(/[*_]/g, "").trim();
        const explanation = colonMatch[2].replace(/[*_]/g, "").trim();
        const key = term.toLowerCase();
        if (
          term.split(/\s+/).length <= 5 &&
          !/^(note|exemple|remarque|attention|définition|source|chapitre|page)/i.test(
            term
          ) &&
          !seenTerms.has(key)
        ) {
          seenTerms.add(key);
          definitions.push({ term, explanation, chunk });
        }
      }

      // 2. Quantitative facts with percentages, units, or key dates
      const pctMatch = line.match(
        /((?:plus de|moins de|environ|près de|entre\s+\d+\s+et\s+)?\d+(?:[.,]\d+)?\s*%)/i
      );
      const yearMatch = !pctMatch
        ? line.match(/\b(1[6-9]\d{2}|20[0-2]\d)\b/)
        : null;
      const unitMatch =
        !pctMatch && !yearMatch
          ? line.match(
              /(\d+(?:[.,]\d+)?(?:\s*(?:à|-|–)\s*\d+(?:[.,]\d+)?)?\s*(?:µm|um|mm|cm|ml|mg|kg|ans|jours|heures|semaines|mois|vétérinaires|espèces|catégories))\b/i
            )
          : null;

      const matchObj = pctMatch || yearMatch || unitMatch;
      if (matchObj && !seenQuants.has(line.slice(0, 50).toLowerCase())) {
        const rawExact = matchObj[1].trim();
        const numMatch = rawExact.match(/(\d+(?:[.,]\d+)?)/);
        if (numMatch) {
          const parsedNum = Number(numMatch[1].replace(",", "."));
          if (Number.isFinite(parsedNum) && parsedNum > 0) {
            const unitTail = rawExact
              .replace(/^.*?\d+(?:[.,]\d+)?(?:\s*(?:à|-|–)\s*\d+(?:[.,]\d+)?)?\s*/, "")
              .trim();
            const built = buildNumericDistractors(
              rawExact,
              unitTail,
              parsedNum,
              Boolean(pctMatch),
              Boolean(yearMatch)
            );
            const masked = line.replace(rawExact, "[ ... ]").slice(0, 150);
            if (masked.includes("[ ... ]")) {
              seenQuants.add(line.slice(0, 50).toLowerCase());
              quantFacts.push({
                subject: chunk.chapterTitle,
                exactValue: rawExact,
                options: built.options,
                correctIndex: built.correctIndex,
                contextSentence: masked,
                chunk,
              });
            }
          }
        }
      }
    }
  }

  return { definitions, quantFacts };
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

  const words = cleanChunkTextForAi(text)
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
  const { definitions, quantFacts } = extractCourseFacts([
    chunk,
    ...otherChunks.slice(0, 12),
  ]);

  const chunkQuant = quantFacts.find((q) => q.chunk.documentId === chunk.documentId);
  if (chunkQuant) {
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
      prompt: `D'après « ${chunk.chapterTitle} », quelle valeur complète exactement : « ${chunkQuant.contextSentence} » ?`,
      options: chunkQuant.options,
      correctIndices: [chunkQuant.correctIndex],
      explanation: `Valeur attendue dans ${chunk.documentTitle} (p.${chunk.pageNumber}) : ${chunkQuant.exactValue}.`,
      generatedByAi: false,
    };
  }

  const chunkDef =
    definitions.find((d) => d.chunk.documentId === chunk.documentId) ||
    definitions[0];
  if (chunkDef) {
    const distractors = definitions
      .filter((d) => d.term.toLowerCase() !== chunkDef.term.toLowerCase())
      .map((d) => d.term)
      .slice(0, 3);
    const termsPool = extractCandidateTerms(
      otherChunks.map((c) => c.content).join(" ")
    );
    while (distractors.length < 3 && termsPool.length > 0) {
      const next = termsPool.shift()!;
      if (
        next.toLowerCase() !== chunkDef.term.toLowerCase() &&
        !distractors.includes(next)
      ) {
        distractors.push(next);
      }
    }
    while (distractors.length < 3) {
      distractors.push(`Concept ${distractors.length + 2}`);
    }
    const shuffled = shuffleOptionsWithIndices(
      [chunkDef.term, ...distractors.slice(0, 3)],
      [0]
    );
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
      prompt: `Quel terme ou notion correspond à : « ${chunkDef.explanation.slice(0, 140)} » ?`,
      options: shuffled.options,
      correctIndices: shuffled.correctIndices,
      explanation: `**${chunkDef.term}** : ${chunkDef.explanation} (${chunk.documentTitle}, p.${chunk.pageNumber}).`,
      generatedByAi: false,
    };
  }

  const sents = splitCleanSentences(chunk.content);
  const targetSent = sents[0] || cleanChunkTextForAi(chunk.content).slice(0, 140);
  const terms = extractCandidateTerms(targetSent);
  const answerTerm = terms[0] || chunk.chapterTitle;
  const masked = targetSent
    .replace(
      new RegExp(`\\b${answerTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
      "[ ... ]"
    )
    .slice(0, 140);
  const altTerms = extractCandidateTerms(
    otherChunks.map((c) => c.content).join(" ")
  )
    .filter((t) => t.toLowerCase() !== answerTerm.toLowerCase())
    .slice(0, 3);
  while (altTerms.length < 3) {
    altTerms.push(`Terme clinique ${altTerms.length + 1}`);
  }
  const shuffled = shuffleOptionsWithIndices([answerTerm, ...altTerms], [0]);

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
    prompt: `Dans « ${chunk.chapterTitle} », quel terme complète exactement : « ${masked} » ?`,
    options: shuffled.options,
    correctIndices: shuffled.correctIndices,
    explanation: `Terme issu de ${chunk.documentTitle} (p.${chunk.pageNumber}) : « ${targetSent} ».`,
    generatedByAi: false,
  };
}

function buildFallbackQCM(
  chunk: SampledChunk,
  otherChunks: SampledChunk[]
): RevisionQuestion {
  const { definitions } = extractCourseFacts([chunk]);
  const { definitions: otherDefs } = extractCourseFacts(
    otherChunks.filter((c) => c.id !== chunk.id).slice(0, 8)
  );

  if (definitions.length >= 2) {
    const rightA = `${definitions[0].term} : ${definitions[0].explanation.slice(0, 65)}`;
    const rightB = `${definitions[1].term} : ${definitions[1].explanation.slice(0, 65)}`;
    const wrongPool = otherDefs
      .filter(
        (d) =>
          d.term !== definitions[0].term && d.term !== definitions[1].term
      )
      .slice(0, 2)
      .map((d) => `${d.term} : ${d.explanation.slice(0, 65)}`);

    while (wrongPool.length < 2) {
      wrongPool.push(
        `Caractéristique étrangère au mécanisme décrit en p.${chunk.pageNumber}`
      );
    }

    const shuffled = shuffleOptionsWithIndices(
      [rightA, rightB, wrongPool[0], wrongPool[1]],
      [0, 1]
    );
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
      prompt: `Parmi ces éléments liés à « ${chunk.chapterTitle} », lesquels sont exacts selon le cours ?`,
      options: shuffled.options,
      correctIndices: shuffled.correctIndices,
      explanation: `Les affirmations exactes proviennent de ${chunk.documentTitle} (p.${chunk.pageNumber}).`,
      generatedByAi: false,
    };
  }

  const terms = extractCandidateTerms(chunk.content);
  const otherTerms = extractCandidateTerms(
    otherChunks
      .filter((c) => c.documentId !== chunk.documentId)
      .map((c) => c.content)
      .join(" ")
  ).filter((t) => !terms.includes(t));

  const right1 = terms[0] || chunk.chapterTitle;
  const right2 = terms[1] || chunk.documentTitle.slice(0, 40);
  const wrong1 = otherTerms[0] || "Paramètre non mentionné ici";
  const wrong2 = otherTerms[1] || "Critère d'un autre module";

  const shuffled = shuffleOptionsWithIndices([right1, right2, wrong1, wrong2], [0, 1]);

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
    prompt: `Quels termes clés appartiennent directement aux mécanismes étudiés dans « ${chunk.chapterTitle} » (p.${chunk.pageNumber}) ?`,
    options: shuffled.options,
    correctIndices: shuffled.correctIndices,
    explanation: `Notions issues de ${chunk.documentTitle} (page ${chunk.pageNumber}).`,
    generatedByAi: false,
  };
}

function buildFallbackQROC(chunk: SampledChunk): RevisionQuestion {
  const { definitions } = extractCourseFacts([chunk]);
  if (definitions.length > 0) {
    const def = definitions[0];
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
      prompt: `Quel terme ou notion correspond à la définition suivante : « ${def.explanation.slice(0, 145)} » ?`,
      correctAnswer: def.term,
      acceptedKeywords: [def.term, ...extractCandidateTerms(def.term)],
      explanation: `${def.term} : ${def.explanation} (${chunk.documentTitle}, p.${chunk.pageNumber}).`,
      generatedByAi: false,
    };
  }

  const sentences = splitCleanSentences(chunk.content);
  const chosenSentence =
    sentences.find((s) => extractCandidateTerms(s).length > 0) ||
    sentences[0] ||
    cleanChunkTextForAi(chunk.content).slice(0, 180);

  const sortedTerms = [
    ...extractCandidateTerms(chosenSentence),
    ...extractCandidateTerms(chunk.content),
  ].sort((a, b) => b.length - a.length);

  const uniqueTerms = Array.from(new Set(sortedTerms));
  const targetTerm = uniqueTerms[0] || chunk.chapterTitle;
  const acceptedKeywords =
    uniqueTerms.length > 0 ? uniqueTerms.slice(0, 5) : [targetTerm];

  const escaped = targetTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const maskedContext = chosenSentence
    .replace(new RegExp(`\\b${escaped}\\b`, "i"), "[ ... ]")
    .slice(0, 160);

  const prompt =
    maskedContext !== chosenSentence.slice(0, 160)
      ? `Quel terme clé complète exactement l'énoncé : « ${maskedContext} » ?`
      : `Citez le terme essentiel défini en p.${chunk.pageNumber} de « ${chunk.chapterTitle} ».`;

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
    explanation: `Réponse attendue : « ${targetTerm} » (${chunk.documentTitle}, p.${chunk.pageNumber}).`,
    generatedByAi: false,
  };
}

function buildFallbackFlashcard(chunk: SampledChunk): RevisionQuestion {
  const { definitions, quantFacts } = extractCourseFacts([chunk]);
  if (quantFacts.length > 0) {
    const q = quantFacts[0];
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
      prompt: `Quelle valeur ou seuil caractérise : ${q.contextSentence} ?`,
      flashcardBack: `**${q.exactValue}** (${chunk.documentTitle}, p.${chunk.pageNumber}).`,
      explanation: `Repère clé issu de ${chunk.documentTitle} (p.${chunk.pageNumber}).`,
      generatedByAi: false,
    };
  }
  if (definitions.length > 0) {
    const d = definitions[0];
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
      prompt: `Comment définir ou caractériser « ${d.term} » dans « ${chunk.chapterTitle} » ?`,
      flashcardBack: d.explanation,
      explanation: `Synthèse issue de ${chunk.documentTitle} (p.${chunk.pageNumber}).`,
      generatedByAi: false,
    };
  }

  const sentences = splitCleanSentences(chunk.content);
  const terms = extractCandidateTerms(chunk.content).sort(
    (a, b) => b.length - a.length
  );
  const topTerm = terms[0] || chunk.chapterTitle;
  const summary =
    sentences.slice(0, 2).join(" ") ||
    cleanChunkTextForAi(chunk.content).slice(0, 220);

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
    prompt: `Quel rôle ou mécanisme clé caractérise « ${topTerm} » en ${chunk.ueCode} ?`,
    flashcardBack: summary,
    explanation: `Synthèse issue de ${chunk.documentTitle} (page ${chunk.pageNumber}).`,
    generatedByAi: false,
  };
}

export function buildFactFlashcardsFromChunks(
  chunks: FactChunkLike[],
  targetCount: number,
  seenPrompts: Set<string> = new Set()
): Array<{
  front: string;
  back: string;
  tag: string;
  documentId: string;
  fileName: string;
  pageNumber: number;
  ueId: string;
}> {
  const { quantFacts, definitions } = extractCourseFacts(chunks);
  const out: Array<{
    front: string;
    back: string;
    tag: string;
    documentId: string;
    fileName: string;
    pageNumber: number;
    ueId: string;
  }> = [];

  const tryPush = (
    front: string,
    back: string,
    tag: string,
    chunk: FactChunkLike
  ) => {
    const key = front.toLowerCase().slice(0, 60);
    if (seenPrompts.has(key) || out.length >= targetCount) return;
    seenPrompts.add(key);
    out.push({
      front,
      back,
      tag,
      documentId: chunk.documentId,
      fileName: chunk.fileName,
      pageNumber: chunk.pageNumber,
      ueId: chunk.ueId,
    });
  };

  for (const q of quantFacts) {
    tryPush(
      `Quelle valeur précise correspond à : « ${q.contextSentence} » ?`,
      `**${q.exactValue}** (${q.chunk.documentTitle}, p.${q.chunk.pageNumber}).`,
      "VALEUR CLÉ",
      q.chunk
    );
  }

  for (const d of definitions) {
    tryPush(
      `Que désigne ou caractérise « ${d.term} » dans « ${d.chunk.chapterTitle} » ?`,
      `**${d.term}** : ${d.explanation}`,
      "NOTION CLÉ",
      d.chunk
    );
  }

  for (const c of chunks) {
    if (out.length >= targetCount) break;
    const sents = splitCleanSentences(c.content);
    for (const s of sents) {
      if (out.length >= targetCount) break;
      const terms = extractCandidateTerms(s).sort((a, b) => b.length - a.length);
      const term = terms[0] || c.chapterTitle;
      tryPush(
        `Quel point essentiel faut-il retenir concernant « ${term} » (${c.ueCode}) ?`,
        s,
        c.ueCode,
        c
      );
    }
  }

  return out.slice(0, targetCount);
}

export function buildFactQuestionsFromChunks(
  chunks: FactChunkLike[],
  targetCount: number,
  seenPrompts: Set<string> = new Set()
): RevisionQuestion[] {
  const { quantFacts, definitions } = extractCourseFacts(chunks);
  const out: RevisionQuestion[] = [];
  const allTerms = extractCandidateTerms(chunks.map((c) => c.content).join(" "));

  const pushQuestion = (q: RevisionQuestion) => {
    const key = q.prompt.toLowerCase().slice(0, 60);
    if (seenPrompts.has(key) || out.length >= targetCount) return;
    seenPrompts.add(key);
    out.push(q);
  };

  for (const q of quantFacts) {
    if (out.length >= targetCount) break;
    pushQuestion({
      id: `sq-${out.length + 1}-${crypto.randomUUID().slice(0, 4)}`,
      type: "QCU",
      ueId: q.chunk.ueId,
      ueCode: q.chunk.ueCode,
      ueTitle: q.chunk.ueTitle,
      chapterTitle: q.chunk.chapterTitle,
      documentId: q.chunk.documentId,
      documentTitle: q.chunk.documentTitle,
      fileName: q.chunk.fileName,
      pageNumber: q.chunk.pageNumber,
      prompt: `D'après « ${q.chunk.chapterTitle} », quelle valeur complète exactement : « ${q.contextSentence} » ?`,
      options: q.options,
      correctIndices: [q.correctIndex],
      explanation: `Valeur attendue dans ${q.chunk.documentTitle} (p.${q.chunk.pageNumber}) : ${q.exactValue}.`,
      generatedByAi: false,
    });
  }

  for (let i = 0; i < definitions.length && out.length < targetCount; i += 1) {
    const def = definitions[i];
    const otherDefs = definitions.filter(
      (d) => d.term.toLowerCase() !== def.term.toLowerCase()
    );
    const distractors = otherDefs.slice(0, 3).map((d) => d.term);
    for (const t of allTerms) {
      if (distractors.length >= 3) break;
      if (t.toLowerCase() !== def.term.toLowerCase() && !distractors.includes(t)) {
        distractors.push(t);
      }
    }
    while (distractors.length < 3) {
      distractors.push(`Notion ${distractors.length + 2}`);
    }

    if (i % 3 === 2) {
      pushQuestion({
        id: `sq-${out.length + 1}-${crypto.randomUUID().slice(0, 4)}`,
        type: "QROC",
        ueId: def.chunk.ueId,
        ueCode: def.chunk.ueCode,
        ueTitle: def.chunk.ueTitle,
        chapterTitle: def.chunk.chapterTitle,
        documentId: def.chunk.documentId,
        documentTitle: def.chunk.documentTitle,
        fileName: def.chunk.fileName,
        pageNumber: def.chunk.pageNumber,
        prompt: `Quel concept précis correspond à : « ${def.explanation.slice(0, 140)} » ?`,
        correctAnswer: def.term,
        acceptedKeywords: [def.term, ...extractCandidateTerms(def.term)],
        explanation: `${def.term} : ${def.explanation} (${def.chunk.documentTitle}, p.${def.chunk.pageNumber}).`,
        generatedByAi: false,
      });
    } else {
      const shuffled = shuffleOptionsWithIndices(
        [def.term, ...distractors.slice(0, 3)],
        [0]
      );
      pushQuestion({
        id: `sq-${out.length + 1}-${crypto.randomUUID().slice(0, 4)}`,
        type: "QCU",
        ueId: def.chunk.ueId,
        ueCode: def.chunk.ueCode,
        ueTitle: def.chunk.ueTitle,
        chapterTitle: def.chunk.chapterTitle,
        documentId: def.chunk.documentId,
        documentTitle: def.chunk.documentTitle,
        fileName: def.chunk.fileName,
        pageNumber: def.chunk.pageNumber,
        prompt: `Quel terme ou notion correspond à : « ${def.explanation.slice(0, 140)} » ?`,
        options: shuffled.options,
        correctIndices: shuffled.correctIndices,
        explanation: `${def.term} : ${def.explanation} (${def.chunk.documentTitle}, p.${def.chunk.pageNumber}).`,
        generatedByAi: false,
      });
    }
  }

  for (const chunk of chunks) {
    if (out.length >= targetCount) break;
    const sents = splitCleanSentences(chunk.content);
    for (const s of sents) {
      if (out.length >= targetCount) break;
      const terms = extractCandidateTerms(s);
      if (terms.length === 0) continue;
      const answer = terms[0];
      const masked = s
        .replace(
          new RegExp(`\\b${answer.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"),
          "[ ... ]"
        )
        .slice(0, 145);
      if (!masked.includes("[ ... ]")) continue;
      const opts = allTerms
        .filter((t) => t.toLowerCase() !== answer.toLowerCase())
        .slice(0, 3);
      while (opts.length < 3) opts.push(`Concept ${opts.length + 1}`);
      const shuffled = shuffleOptionsWithIndices([answer, ...opts], [0]);
      pushQuestion({
        id: `sq-${out.length + 1}-${crypto.randomUUID().slice(0, 4)}`,
        type: "QCU",
        ueId: chunk.ueId,
        ueCode: chunk.ueCode,
        ueTitle: chunk.ueTitle,
        chapterTitle: chunk.chapterTitle,
        documentId: chunk.documentId,
        documentTitle: chunk.documentTitle,
        fileName: chunk.fileName,
        pageNumber: chunk.pageNumber,
        prompt: `Dans « ${chunk.chapterTitle} », quel terme complète exactement : « ${masked} » ?`,
        options: shuffled.options,
        correctIndices: shuffled.correctIndices,
        explanation: `Terme attendu : ${answer} (${chunk.documentTitle}, p.${chunk.pageNumber}).`,
        generatedByAi: false,
      });
    }
  }

  return out.slice(0, targetCount);
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
  const timer = setTimeout(() => controller.abort(), 90000);

  const ex1 = selectHighValueText(qcuChunk.content, 520);
  const ex2 = selectHighValueText(qcmChunk.content, 520);
  const ex3 = selectHighValueText(qrocChunk.content, 520);
  const ex4 = selectHighValueText(flashcardChunk.content, 520);

  const prompt = `Tu es un générateur de révisions de niveau NotebookLM pour étudiants vétérinaires.
Génère strictement un objet JSON valide avec 4 exercices basés sur les VALEURS, NOTIONS, DÉFINITIONS et MÉCANISMES extraits de ces 4 cours.

RÈGLES ABSOLUES :
1. NE JAMAIS recopier une phrase du polycopié en option de réponse ou demander « quelle affirmation figure dans le cours ».
2. QCU : pose une question directe et précise sur une valeur chiffrée (%, taille, date, seuil), un mécanisme ou une définition. Les 4 options doivent être COURTES (1 à 8 mots, homogènes) comme : ["Moins de 5%", "Environ 10 à 15%", "Plus de 90%", "Exactement 50%"]. Varie l'indice de la bonne réponse (pas toujours 0).
3. QCM : question à 2 ou 3 bonnes réponses, options courtes et précises (maximum 10 mots par option).
4. QROC : question ouverte courte dont la réponse attendue tient en 1 à 4 mots exacts.
5. FLASHCARD : Recto = une seule question courte et directe (ex : "Quelle est la plage de taille caractéristique d'un érythrocyte chez les mammifères ?"). Verso = réponse exacte et concise (1 à 2 phrases avec la valeur/notion clé).

EXTRAIT 1 (QCU) [${qcuChunk.ueCode} · ${qcuChunk.chapterTitle}]:
${ex1}

EXTRAIT 2 (QCM) [${qcmChunk.ueCode} · ${qcmChunk.chapterTitle}]:
${ex2}

EXTRAIT 3 (QROC) [${qrocChunk.ueCode} · ${qrocChunk.chapterTitle}]:
${ex3}

EXTRAIT 4 (FLASHCARD) [${flashcardChunk.ueCode} · ${flashcardChunk.chapterTitle}]:
${ex4}

Réponds STRICTEMENT en JSON :
{
  "qcu": {
    "prompt": "Question directe sur une valeur ou notion clé ?",
    "options": ["Option courte A", "Option courte B", "Option courte C", "Option courte D"],
    "correctIndices": [2],
    "explanation": "Justification concise sourcée."
  },
  "qcm": {
    "prompt": "Parmi ces propositions sur [notion], lesquelles sont exactes ?",
    "options": ["Élément court 1", "Élément court 2", "Élément court 3", "Élément court 4"],
    "correctIndices": [0, 2],
    "explanation": "Justification concise."
  },
  "qroc": {
    "prompt": "Question courte appelant un terme, chiffre ou mécanisme précis ?",
    "correctAnswer": "Réponse courte",
    "acceptedKeywords": ["motcle1", "motcle2"],
    "explanation": "Justification concise."
  },
  "flashcard": {
    "prompt": "Question directe et courte (1 phrase) sur une valeur ou notion ?",
    "flashcardBack": "Réponse précise et concise issue du cours.",
    "explanation": "Repère clé."
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
        options: {
          temperature: 0.25,
          num_ctx: 4096,
          num_predict: 1600,
        },
      }),
      signal: controller.signal,
    });

    if (!res.ok) return null;
    const data = (await res.json()) as { response?: string };
    if (!data.response) return null;

    const parsed = parseOllamaJsonWithRecovery<{
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
      parsed.qcu.correctIndices.length >= 1 &&
      parsed.qcu.correctIndices[0] >= 0 &&
      parsed.qcu.correctIndices[0] < 4 &&
      !isLowQualityExcerptQuestion(parsed.qcu.prompt, parsed.qcu.options)
    ) {
      const shuffledQcu = shuffleOptionsWithIndices(
        parsed.qcu.options.map((o) => String(o).trim()),
        [parsed.qcu.correctIndices[0]]
      );
      result.qcu = {
        prompt: parsed.qcu.prompt.trim(),
        options: shuffledQcu.options,
        correctIndices: shuffledQcu.correctIndices,
        explanation: (parsed.qcu.explanation || "").trim(),
        generatedByAi: true,
      };
    }

    if (
      parsed.qcm?.prompt &&
      Array.isArray(parsed.qcm.options) &&
      parsed.qcm.options.length === 4 &&
      Array.isArray(parsed.qcm.correctIndices) &&
      !isLowQualityExcerptQuestion(parsed.qcm.prompt, parsed.qcm.options)
    ) {
      const validIndices = Array.from(
        new Set(
          parsed.qcm.correctIndices.filter(
            (i) => typeof i === "number" && i >= 0 && i < 4
          )
        )
      ).sort((a, b) => a - b);

      if (validIndices.length >= 2) {
        const shuffledQcm = shuffleOptionsWithIndices(
          parsed.qcm.options.map((o) => String(o).trim()),
          validIndices
        );
        result.qcm = {
          prompt: parsed.qcm.prompt.trim(),
          options: shuffledQcm.options,
          correctIndices: shuffledQcm.correctIndices,
          explanation: (parsed.qcm.explanation || "").trim(),
          generatedByAi: true,
        };
      }
    }

    if (
      parsed.qroc?.prompt &&
      typeof parsed.qroc.correctAnswer === "string" &&
      parsed.qroc.correctAnswer.trim().length > 0 &&
      !isLowQualityExcerptQuestion(parsed.qroc.prompt)
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
      parsed.flashcard.flashcardBack.trim().length > 0 &&
      !isLowQualityExcerptQuestion(parsed.flashcard.prompt)
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
      b < 4 ? await tryOllamaQuizEnrichment(c1, c2, c3, c4) : null;

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

export interface SharedDailyQuizRecord {
  dateKey: string;
  ueId: string | null;
  ueCode: string | null;
  ueTitle: string | null;
  questions: RevisionQuestion[];
  totalQuestions: number;
  generatedByAi: boolean;
  generatedAt: string;
}

interface SharedDailyQuizRow {
  dateKey: string;
  ueId: string | null;
  ueCode: string | null;
  ueTitle: string | null;
  questionsJson: string;
  totalQuestions: number;
  generatedByAi: boolean;
  generatedAt: Date | string;
}

const globalForSharedQuiz = globalThis as typeof globalThis & {
  __araSharedDailyQuizInFlight?: Map<
    string,
    Promise<SharedDailyQuizRecord | null>
  >;
};

function getSharedQuizInFlightMap(): Map<
  string,
  Promise<SharedDailyQuizRecord | null>
> {
  if (!globalForSharedQuiz.__araSharedDailyQuizInFlight) {
    globalForSharedQuiz.__araSharedDailyQuizInFlight = new Map();
  }
  return globalForSharedQuiz.__araSharedDailyQuizInFlight;
}

function parseSharedQuizRow(
  row: SharedDailyQuizRow
): SharedDailyQuizRecord | null {
  try {
    const parsed = JSON.parse(row.questionsJson) as RevisionQuestion[];
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return {
      dateKey: row.dateKey,
      ueId: row.ueId,
      ueCode: row.ueCode,
      ueTitle: row.ueTitle,
      questions: parsed,
      totalQuestions: Number(row.totalQuestions || parsed.length),
      generatedByAi: Boolean(row.generatedByAi),
      generatedAt:
        row.generatedAt instanceof Date
          ? row.generatedAt.toISOString()
          : String(row.generatedAt),
    };
  } catch {
    return null;
  }
}

export async function hasSharedDailyQuizForToday(): Promise<boolean> {
  await ensureRevisionSchema();
  const dateKey = getLocalDateKey();
  const rows = await prisma.$queryRaw<Array<{ dateKey: string }>>`
    SELECT "dateKey" FROM "SharedDailyQuiz" WHERE "dateKey" = ${dateKey} LIMIT 1
  `;
  return rows.length > 0;
}

export async function getOrGenerateSharedDailyQuiz(options?: {
  forceRegenerate?: boolean;
  dateKey?: string;
}): Promise<SharedDailyQuizRecord | null> {
  await ensureRevisionSchema();
  const dateKey = options?.dateKey || getLocalDateKey();
  const forceRegenerate = Boolean(options?.forceRegenerate);

  if (!forceRegenerate) {
    const existingRows = await prisma.$queryRaw<SharedDailyQuizRow[]>`
      SELECT "dateKey", "ueId", "ueCode", "ueTitle", "questionsJson",
             "totalQuestions", "generatedByAi", "generatedAt"
      FROM "SharedDailyQuiz"
      WHERE "dateKey" = ${dateKey}
      LIMIT 1
    `;
    const existing = existingRows[0]
      ? parseSharedQuizRow(existingRows[0])
      : null;

    if (existing) {
      const hasStaleCopyPaste = existing.questions.some((q) =>
        isLowQualityExcerptQuestion(q.prompt, q.options)
      );
      const needsAiUpgrade =
        !existing.generatedByAi && (await checkOllamaHealth()).online;

      if (!hasStaleCopyPaste && !needsAiUpgrade) {
        return existing;
      }
    }
  }

  const inFlight = getSharedQuizInFlightMap();
  const lockKey = `${dateKey}:${forceRegenerate ? "force" : "auto"}`;
  const running = inFlight.get(lockKey);
  if (running) return running;

  const task = (async (): Promise<SharedDailyQuizRecord | null> => {
    try {
      // 8 questions = 2 full rounds (QCU + QCM + QROC + FLASHCARD) across random courses of 1 random UE
      const questions = await generateQuizQuestions({ count: 8 });
      if (questions.length === 0) return null;

      const ueId = questions[0]?.ueId || null;
      const ueCode = questions[0]?.ueCode || null;
      const ueTitle = questions[0]?.ueTitle || null;
      const generatedByAi = questions.some((q) => Boolean(q.generatedByAi));
      const questionsJson = JSON.stringify(questions);

      await prisma.$executeRaw`
        INSERT INTO "SharedDailyQuiz" (
          "dateKey", "ueId", "ueCode", "ueTitle",
          "questionsJson", "totalQuestions", "generatedByAi", "generatedAt"
        )
        VALUES (
          ${dateKey}, ${ueId}, ${ueCode}, ${ueTitle},
          ${questionsJson}, ${questions.length}, ${generatedByAi}, NOW()
        )
        ON CONFLICT ("dateKey") DO UPDATE SET
          "ueId" = EXCLUDED."ueId",
          "ueCode" = EXCLUDED."ueCode",
          "ueTitle" = EXCLUDED."ueTitle",
          "questionsJson" = EXCLUDED."questionsJson",
          "totalQuestions" = EXCLUDED."totalQuestions",
          "generatedByAi" = EXCLUDED."generatedByAi",
          "generatedAt" = NOW()
      `;

      // Sync unstarted incomplete daily sessions for today so everyone shares this official quiz
      await prisma.dailyRevisionSession.updateMany({
        where: {
          dateKey,
          completed: false,
          answersJson: "{}",
        },
        data: {
          questionsJson,
          totalQuestions: questions.length,
        },
      });

      const savedRows = await prisma.$queryRaw<SharedDailyQuizRow[]>`
        SELECT "dateKey", "ueId", "ueCode", "ueTitle", "questionsJson",
               "totalQuestions", "generatedByAi", "generatedAt"
        FROM "SharedDailyQuiz"
        WHERE "dateKey" = ${dateKey}
        LIMIT 1
      `;

      return savedRows[0]
        ? parseSharedQuizRow(savedRows[0])
        : {
            dateKey,
            ueId,
            ueCode,
            ueTitle,
            questions,
            totalQuestions: questions.length,
            generatedByAi,
            generatedAt: new Date().toISOString(),
          };
    } catch (err) {
      console.error("[SharedDailyQuiz] Generation error:", err);
      return null;
    } finally {
      inFlight.delete(lockKey);
    }
  })();

  inFlight.set(lockKey, task);
  return task;
}

export async function runScheduled6AmDailyQuizGeneration(options?: {
  force?: boolean;
}): Promise<{
  dateKey: string;
  ueCode: string | null;
  questionCount: number;
  generatedByAi: boolean;
  preparedSessions: number;
} | null> {
  const shared = await getOrGenerateSharedDailyQuiz({
    forceRegenerate: options?.force,
  });
  if (!shared) return null;

  const questionsJson = JSON.stringify(shared.questions);
  const [enabledUsers, existingSessions] = await Promise.all([
    prisma.user.findMany({
      where: { revisionEnabled: true },
      select: { id: true },
    }),
    prisma.dailyRevisionSession.findMany({
      where: { dateKey: shared.dateKey },
      select: { userId: true },
    }),
  ]);

  const existingSet = new Set(existingSessions.map((s) => s.userId));
  const missingUsers = enabledUsers.filter((u) => !existingSet.has(u.id));

  if (missingUsers.length > 0) {
    await prisma.dailyRevisionSession.createMany({
      data: missingUsers.map((u) => ({
        userId: u.id,
        dateKey: shared.dateKey,
        questionsJson,
        totalQuestions: shared.questions.length,
      })),
      skipDuplicates: true,
    });
  }

  return {
    dateKey: shared.dateKey,
    ueCode: shared.ueCode,
    questionCount: shared.questions.length,
    generatedByAi: shared.generatedByAi,
    preparedSessions: missingUsers.length,
  };
}
