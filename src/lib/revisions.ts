import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  checkOllamaHealth,
  getOllamaConfig,
  getOllamaInferenceOptions,
  OLLAMA_KEEP_ALIVE,
  OLLAMA_STRICT_SYSTEM_RULE,
  OLLAMA_TIMEOUT_MS,
  ollamaPostJson,
  withOllamaLock,
} from "@/lib/ollama";
import { hasUsableText } from "@/lib/pdf";
import { getSystemSettings } from "@/lib/system-settings";
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
 * Daily quiz boundary shifts at 06:00 AM Europe/Paris time so nightly generation runs
 * at 06:00 and late-night students (00:00–05:59) can still finish yesterday's quiz.
 */
export function getLocalDateKey(date = new Date()): string {
  const shifted = new Date(date.getTime() - 6 * 60 * 60 * 1000);
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/Paris",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(shifted);
  } catch {
    const year = shifted.getFullYear();
    const month = String(shifted.getMonth() + 1).padStart(2, "0");
    const day = String(shifted.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
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

const GENERIC_PLACEHOLDER_PATTERNS: RegExp[] = [
  /^r[eé]ponse\s+courte(?:\s*\d+)?$/i,
  /^option\s+courte(?:\s*[a-d0-9])?$/i,
  /^[eé]l[eé]ment\s+court(?:\s*\d+)?$/i,
  /^proposition\s*(?:[a-d0-9]|exemple)$/i,
  /^question\s+exemple\b/i,
  /quel\s+terme\s+d[eé]signe\s+l['’]agent\s+ou\s+le\s+concept\s+cl[eé]\s+de\s+cette\s+[eé]tape/i,
  /^question\s+(?:directe|courte)\s+(?:sur\s+une\s+valeur|appelant\s+un\s+terme)/i,
  /^parmi\s+ces\s+(?:[eé]l[eé]ments\s+concernant\s+ce\s+m[eé]canisme|propositions\s+sur\s+\[notion\])/i,
  /^justification\s+concise(?:\s+sourc[eé]e)?\.?$/i,
  /^r[eé]ponse\s+(?:pr[eé]cise\s+et\s+concise\s+issue\s+du\s+cours|cl[eé]\s*:\s*explication\s+concise)/i,
  /^rep[eè]re\s+cl[eé]\.?$/i,
  /^motcl[eé]\d*$/i,
  /^titre\s+court\s+du\s+sch[eé]ma$/i,
  /^sous-titre\s+acad[eé]mique$/i,
  /^[eé]l[eé]ment\s+r[eé]el\s+[ab]$/i,
  /^donn[eé]e\s+r[eé]elle\s+[ab]\d$/i,
  /^caract[eé]ristique\s+[12]$/i,
  /^autre\s+(?:sous-partie\s+th[eé]matique|terme)$/i,
  /^terme\s+cl[eé]$/i,
  /\[notion\]/i,
];

export function hasGenericPlaceholderLeak(text?: string | null): boolean {
  if (!text) return false;
  const normalized = text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return GENERIC_PLACEHOLDER_PATTERNS.some((re) => re.test(normalized));
}

export function isLowQualityExcerptQuestion(
  prompt: string,
  options?: string[],
  answerOrBack?: string
): boolean {
  if (hasGenericPlaceholderLeak(prompt)) {
    return true;
  }
  if (answerOrBack && hasGenericPlaceholderLeak(answerOrBack)) {
    return true;
  }
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
    if (hasGenericPlaceholderLeak(clean)) {
      return true;
    }
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

      // 2. Quantitative facts with percentages, units, or genuine historical dates (ignore bibliography/course headers)
      const isBiblioOrHeader =
        /\b(?:et al\.?|ed\.?|édition|press|wiley|elsevier|masson|saunders|springer|pearson|physiologie humaine|bibliographie|références)\b/i.test(
          line
        ) || /\b(?:ue\s*\d+|202[4-9])\b/i.test(line);

      const pctMatch = line.match(
        /((?:plus de|moins de|environ|près de|entre\s+\d+\s+et\s+)?\d+(?:[.,]\d+)?\s*%)/i
      );
      const hasHistoricalContext =
        /\b(?:créé|créée|fondé|fondée|découvert|découverte|institué|loi|décret|ordonnance|siècle|première|premier|école|révolution|naissance)\b/i.test(
          line
        );
      const yearMatch =
        !pctMatch && !isBiblioOrHeader && hasHistoricalContext
          ? line.match(/\b(1[6-9]\d{2}|20[0-1]\d)\b/)
          : null;
      const unitMatch =
        !pctMatch && !yearMatch && !isBiblioOrHeader
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

const REVISION_ENRICHMENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    qcu: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Question interrogative directe, précise et contextualisée basée exclusivement sur l'extrait 1",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "Exactement 4 propositions courtes (1 à 8 mots), homogènes, sans lettre préfixe, issues du domaine de l'extrait 1",
        },
        correctIndices: {
          type: "array",
          items: { type: "integer" },
          description:
            "Tableau contenant l'unique indice (0 à 3) de la bonne réponse dans options",
        },
        explanation: {
          type: "string",
          description:
            "Explication pédagogique concise fondée uniquement sur les faits de l'extrait 1",
        },
      },
      required: ["prompt", "options", "correctIndices", "explanation"],
    },
    qcm: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Question à choix multiples précise portant sur les notions réelles de l'extrait 2",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "Exactement 4 propositions courtes (1 à 10 mots), sans lettre préfixe, dont 2 ou 3 sont exactes selon l'extrait 2",
        },
        correctIndices: {
          type: "array",
          items: { type: "integer" },
          description:
            "Tableau contenant les 2 ou 3 indices (0 à 3) des propositions exactes",
        },
        explanation: {
          type: "string",
          description:
            "Explication pédagogique concise fondée uniquement sur les faits de l'extrait 2",
        },
      },
      required: ["prompt", "options", "correctIndices", "explanation"],
    },
    qroc: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Question ouverte courte et précise portant sur un terme, une valeur ou un mécanisme exact de l'extrait 3",
        },
        correctAnswer: {
          type: "string",
          description:
            "Réponse attendue en 1 à 4 mots exacts tirée directement de l'extrait 3",
        },
        acceptedKeywords: {
          type: "array",
          items: { type: "string" },
          description:
            "Mots-clés scientifiques et synonymes acceptés tirés de l'extrait 3",
        },
        explanation: {
          type: "string",
          description:
            "Explication pédagogique concise fondée uniquement sur les faits de l'extrait 3",
        },
      },
      required: ["prompt", "correctAnswer", "acceptedKeywords", "explanation"],
    },
    flashcard: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "Question recto directe en une phrase portant sur un fait précis de l'extrait 4",
        },
        flashcardBack: {
          type: "string",
          description:
            "Réponse verso exacte et concise (1 à 2 phrases) issue uniquement de l'extrait 4",
        },
        explanation: {
          type: "string",
          description:
            "Repère pédagogique concis tiré des faits de l'extrait 4",
        },
      },
      required: ["prompt", "flashcardBack", "explanation"],
    },
  },
  required: ["qcu", "qcm", "qroc", "flashcard"],
};

async function tryOllamaQuizEnrichment(
  qcuChunk: SampledChunk,
  qcmChunk: SampledChunk,
  qrocChunk: SampledChunk,
  flashcardChunk: SampledChunk,
  meta?: {
    chapterTitle?: string;
    freshnessSeed?: string;
    avoidPrompts?: string[];
  }
): Promise<{
  qcu?: Partial<RevisionQuestion>;
  qcm?: Partial<RevisionQuestion>;
  qroc?: Partial<RevisionQuestion>;
  flashcard?: Partial<RevisionQuestion>;
} | null> {
  const ex1 = selectHighValueText(qcuChunk.content, 800);
  const ex2 = selectHighValueText(qcmChunk.content, 800);
  const ex3 = selectHighValueText(qrocChunk.content, 800);
  const ex4 = selectHighValueText(flashcardChunk.content, 800);

  if (!hasUsableText(`${ex1} ${ex2} ${ex3} ${ex4}`)) {
    console.error(
      "[Revisions] Enrichissement IA annulé : extraits sources vides ou non exploitables."
    );
    return null;
  }

  return withOllamaLock(async () => {
    const health = await checkOllamaHealth({ useCache: true });
    if (!health.online) return null;

    const { model } = getOllamaConfig();

    const chapterFocus = meta?.chapterTitle
      ? `CHAPITRE CIBLÉ : « ${meta.chapterTitle} » (${qcuChunk.ueCode}).\n`
      : "";
    const freshnessBlock = meta?.freshnessSeed
      ? `CONSIGNE DE FRAÎCHEUR (${meta.freshnessSeed}) : Rédige des questions originales sous un angle nouveau.\n`
      : "";
    const avoidBlock =
      meta?.avoidPrompts && meta.avoidPrompts.length > 0
        ? `NE RÉPÈTE PAS ces intitulés déjà générés :\n- ${meta.avoidPrompts
            .slice(-6)
            .join("\n- ")}\n`
        : "";

    // Static system prompt kept identical across all 5 chapter batches for Ollama KV-cache prefix reuse
    const systemPrompt = `Tu es un enseignant universitaire vétérinaire chargé de créer un QCU, un QCM, une QROC et une flashcard de révision à partir de quatre extraits de cours.
${OLLAMA_STRICT_SYSTEM_RULE}

RÈGLES JSON STRICTES (4 champs racines : "qcu", "qcm", "qroc", "flashcard") :
1. INTERDIT de recopier des phrases complètes du polycopié en propositions de réponse ou de demander quelle affirmation figure dans le cours.
2. Champ "qcu" (basé sur l'EXTRAIT 1) :
   - "prompt" : question directe, autonome et précise testant un chiffre, un seuil, une définition ou un mécanisme réel de l'extrait 1.
   - "options" : tableau de 4 propositions courtes (1 à 8 mots chacune), homogènes, plausibles, sans préfixe alphabétique.
   - "correctIndices" : tableau contenant l'unique indice (0 à 3) de la bonne réponse, en variant la position.
   - "explanation" : justification factuelle concise tirée de l'extrait 1.
3. Champ "qcm" (basé sur l'EXTRAIT 2) :
   - "prompt" : question à choix multiples contextualisée sur le mécanisme ou la notion de l'extrait 2.
   - "options" : tableau de 4 propositions courtes (1 à 10 mots chacune), sans préfixe alphabétique.
   - "correctIndices" : tableau contenant exactement 2 ou 3 indices (0 à 3) des propositions exactes.
   - "explanation" : justification factuelle concise tirée de l'extrait 2.
4. Champ "qroc" (basé sur l'EXTRAIT 3) :
   - "prompt" : question ouverte courte et précise appelant un terme scientifique, une valeur ou un mécanisme concret de l'extrait 3.
   - "correctAnswer" : réponse exacte attendue en 1 à 4 mots issus de l'extrait 3.
   - "acceptedKeywords" : liste de mots-clés scientifiques et synonymes pertinents tirés de l'extrait 3.
   - "explanation" : justification factuelle concise tirée de l'extrait 3.
5. Champ "flashcard" (basé sur l'EXTRAIT 4) :
   - "prompt" : question recto directe en une seule phrase portant sur un fait précis de l'extrait 4.
   - "flashcardBack" : réponse verso exacte et concise (1 à 2 phrases) issue de l'extrait 4.
   - "explanation" : repère pédagogique issu de l'extrait 4.`;

    const prompt = `${chapterFocus}${freshnessBlock}${avoidBlock}Produis l'objet JSON ("qcu", "qcm", "qroc", "flashcard") à partir de ces quatre extraits :

EXTRAIT 1 (pour qcu) [${qcuChunk.ueCode} · ${qcuChunk.chapterTitle}]:
${ex1}

EXTRAIT 2 (pour qcm) [${qcmChunk.ueCode} · ${qcmChunk.chapterTitle}]:
${ex2}

EXTRAIT 3 (pour qroc) [${qrocChunk.ueCode} · ${qrocChunk.chapterTitle}]:
${ex3}

EXTRAIT 4 (pour flashcard) [${flashcardChunk.ueCode} · ${flashcardChunk.chapterTitle}]:
${ex4}`;

    try {
      const requestBody = {
        model,
        system: systemPrompt,
        prompt,
        format: REVISION_ENRICHMENT_SCHEMA as unknown,
        keep_alive: OLLAMA_KEEP_ALIVE,
        stream: false,
        options: getOllamaInferenceOptions({
          num_predict: 1400,
          repeat_penalty: 1.12,
        }),
      };

      let res = await ollamaPostJson<{ response?: string }>(
        "/api/generate",
        requestBody,
        OLLAMA_TIMEOUT_MS
      );

      // Compatibility fallback if an older Ollama server (< 0.5) rejects JSON Schema objects in `format`
      if (!res.ok && res.status === 400) {
        res = await ollamaPostJson<{ response?: string }>(
          "/api/generate",
          { ...requestBody, format: "json" },
          OLLAMA_TIMEOUT_MS
        );
      }

      if (!res.ok || !res.data?.response) return null;

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
      }>(res.data.response);

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
        !isLowQualityExcerptQuestion(parsed.qcu.prompt, parsed.qcu.options) &&
        !hasGenericPlaceholderLeak(parsed.qcu.explanation)
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
        !isLowQualityExcerptQuestion(parsed.qcm.prompt, parsed.qcm.options) &&
        !hasGenericPlaceholderLeak(parsed.qcm.explanation)
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
        !isLowQualityExcerptQuestion(
          parsed.qroc.prompt,
          undefined,
          parsed.qroc.correctAnswer
        ) &&
        !hasGenericPlaceholderLeak(parsed.qroc.explanation)
      ) {
        const mainAnswer = parsed.qroc.correctAnswer.trim();
        const rawKeywords = Array.isArray(parsed.qroc.acceptedKeywords)
          ? parsed.qroc.acceptedKeywords
              .map((k) => String(k).trim())
              .filter((k) => k.length > 0 && !hasGenericPlaceholderLeak(k))
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
        !isLowQualityExcerptQuestion(
          parsed.flashcard.prompt,
          undefined,
          parsed.flashcard.flashcardBack
        ) &&
        !hasGenericPlaceholderLeak(parsed.flashcard.explanation)
      ) {
        result.flashcard = {
          prompt: parsed.flashcard.prompt.trim(),
          flashcardBack: parsed.flashcard.flashcardBack.trim(),
          explanation: (parsed.flashcard.explanation || "").trim(),
          generatedByAi: true,
        };
      }

      return result;
    } catch (err) {
      console.warn("[Revisions] Ollama enrichment error:", err);
      return null;
    }
  });
}

export async function generateQuizQuestions(options?: {
  userId?: string;
  ueId?: string;
  count?: number;
  excludeUeId?: string | null;
  freshnessSeed?: string;
}): Promise<RevisionQuestion[]> {
  const requestedCount = Math.max(4, Math.min(20, options?.count || 20));
  const batchCount = Math.ceil(requestedCount / 4);

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

    if (options?.excludeUeId) {
      const rotated = candidateUeIds.filter((id) => id !== options.excludeUeId);
      if (rotated.length > 0) {
        candidateUeIds = rotated;
      }
    }

    targetUeId =
      candidateUeIds[Math.floor(Math.random() * candidateUeIds.length)];
  }

  // Group all chunks by chapter inside the randomly selected UE
  const chunkRefs = await prisma.documentChunk.findMany({
    where: {
      document: {
        chapter: {
          ueId: targetUeId,
        },
      },
    },
    select: {
      id: true,
      documentId: true,
      document: { select: { chapterId: true } },
    },
  });

  if (chunkRefs.length === 0) {
    return [];
  }

  const refsByChapter = new Map<
    string,
    Array<{ id: string; documentId: string }>
  >();
  for (const ref of chunkRefs) {
    const cid = ref.document.chapterId;
    const arr = refsByChapter.get(cid) || [];
    arr.push({ id: ref.id, documentId: ref.documentId });
    refsByChapter.set(cid, arr);
  }

  // Pick up to `batchCount` (default 5) random distinct chapters inside the UE
  const shuffledChapterIds = shuffle(Array.from(refsByChapter.keys()));
  const selectedChapterSlots: string[] = [];
  for (let slot = 0; slot < batchCount; slot += 1) {
    selectedChapterSlots.push(
      shuffledChapterIds[slot % shuffledChapterIds.length]
    );
  }

  // Sample fresh chunks per chapter slot (spread across different documents in each chapter)
  const pickedIdSet = new Set<string>();
  const slotPickedIds: string[][] = [];

  for (const chapterId of selectedChapterSlots) {
    const refs = shuffle(refsByChapter.get(chapterId) || []);
    const freshRefs = refs.filter((r) => !pickedIdSet.has(r.id));
    const sourceRefs = freshRefs.length >= 4 ? freshRefs : refs;

    const byDoc = new Map<string, string[]>();
    for (const r of sourceRefs) {
      const list = byDoc.get(r.documentId) || [];
      list.push(r.id);
      byDoc.set(r.documentId, list);
    }

    const docQueues = shuffle(Array.from(byDoc.values()));
    const chosenForSlot: string[] = [];
    let depth = 0;
    while (chosenForSlot.length < 10) {
      let added = false;
      for (const q of docQueues) {
        if (depth < q.length) {
          chosenForSlot.push(q[depth]);
          pickedIdSet.add(q[depth]);
          added = true;
          if (chosenForSlot.length >= 10) break;
        }
      }
      if (!added) break;
      depth += 1;
    }
    slotPickedIds.push(chosenForSlot);
  }

  const allPickedIds = Array.from(new Set(slotPickedIds.flat()));
  const rawChunks = await prisma.documentChunk.findMany({
    where: { id: { in: allPickedIds } },
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

  const chunkMap = new Map<string, SampledChunk>();
  for (const c of rawChunks) {
    chunkMap.set(c.id, {
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
    });
  }

  const allPool = shuffle(Array.from(chunkMap.values()));
  const questions: RevisionQuestion[] = [];
  const generatedPrompts: string[] = [];
  const usedSlotChunkIds = new Set<string>();

  for (let b = 0; b < batchCount; b += 1) {
    const slotChunksRaw = (slotPickedIds[b] || [])
      .map((id) => chunkMap.get(id))
      .filter((c): c is SampledChunk => Boolean(c));

    const substantial = slotChunksRaw.filter(
      (c) => c.content.length >= 40 && !usedSlotChunkIds.has(c.id)
    );
    const chapterPool =
      substantial.length >= 4
        ? substantial
        : slotChunksRaw.length > 0
        ? slotChunksRaw
        : allPool;

    const picked4: SampledChunk[] = [];
    for (let k = 0; k < 4; k += 1) {
      const ch = chapterPool[k % chapterPool.length];
      picked4.push(ch);
      usedSlotChunkIds.add(ch.id);
    }

    const [c1, c2, c3, c4] = picked4;
    const slotChapterTitle = c1.chapterTitle;

    const fallbackQcu = buildFallbackQCU(c1, allPool);
    const fallbackQcm = buildFallbackQCM(c2, allPool);
    const fallbackQroc = buildFallbackQROC(c3);
    const fallbackFlashcard = buildFallbackFlashcard(c4);

    const aiEnriched = await tryOllamaQuizEnrichment(c1, c2, c3, c4, {
      chapterTitle: slotChapterTitle,
      freshnessSeed: options?.freshnessSeed,
      avoidPrompts: generatedPrompts,
    });

    const batchQuestions: RevisionQuestion[] = [
      aiEnriched?.qcu ? { ...fallbackQcu, ...aiEnriched.qcu } : fallbackQcu,
      aiEnriched?.qcm ? { ...fallbackQcm, ...aiEnriched.qcm } : fallbackQcm,
      aiEnriched?.qroc ? { ...fallbackQroc, ...aiEnriched.qroc } : fallbackQroc,
      aiEnriched?.flashcard
        ? { ...fallbackFlashcard, ...aiEnriched.flashcard }
        : fallbackFlashcard,
    ];

    for (const bq of batchQuestions) {
      generatedPrompts.push(bq.prompt);
      questions.push(bq);
    }
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
      const hasStaleCopyPaste = existing.questions.some(
        (q) =>
          isLowQualityExcerptQuestion(
            q.prompt,
            q.options,
            q.correctAnswer || q.flashcardBack
          ) || hasGenericPlaceholderLeak(q.explanation)
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
      // Avoid repeating yesterday's UE if >= 2 UEs have courses
      const yKey = getYesterdayDateKey();
      const yRows = await prisma.$queryRaw<Array<{ ueId: string | null }>>`
        SELECT "ueId" FROM "SharedDailyQuiz" WHERE "dateKey" = ${yKey} LIMIT 1
      `;
      const yesterdayUeId = yRows[0]?.ueId || null;

      // 20 questions = 5 random chapters inside 1 random UE (1 fresh 4-exercise quiz per chapter)
      const questions = await generateQuizQuestions({
        count: 20,
        excludeUeId: yesterdayUeId,
        freshnessSeed: `${dateKey}-${crypto.randomUUID().slice(0, 6)}`,
      });
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

export interface SharedDailyQuizTodayStatus {
  dateKey: string;
  readyForToday: boolean;
  ueCode: string | null;
  ueTitle: string | null;
  totalQuestions: number;
  generatedByAi: boolean;
  generatedAt: string | null;
}

export async function getSharedDailyQuizMetaForToday(): Promise<SharedDailyQuizTodayStatus> {
  await ensureRevisionSchema();
  const dateKey = getLocalDateKey();
  const rows = await prisma.$queryRaw<
    Array<{
      dateKey: string;
      ueCode: string | null;
      ueTitle: string | null;
      totalQuestions: number;
      generatedByAi: boolean;
      generatedAt: Date | string;
    }>
  >`
    SELECT "dateKey", "ueCode", "ueTitle", "totalQuestions", "generatedByAi", "generatedAt"
    FROM "SharedDailyQuiz"
    WHERE "dateKey" = ${dateKey}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) {
    return {
      dateKey,
      readyForToday: false,
      ueCode: null,
      ueTitle: null,
      totalQuestions: 0,
      generatedByAi: false,
      generatedAt: null,
    };
  }
  return {
    dateKey: row.dateKey,
    readyForToday: Number(row.totalQuestions || 0) > 0,
    ueCode: row.ueCode || null,
    ueTitle: row.ueTitle || null,
    totalQuestions: Number(row.totalQuestions || 0),
    generatedByAi: Boolean(row.generatedByAi),
    generatedAt:
      row.generatedAt instanceof Date
        ? row.generatedAt.toISOString()
        : String(row.generatedAt),
  };
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
  const settings = await getSystemSettings();
  if (!settings.dailyQuizEnabled) {
    return null;
  }

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
