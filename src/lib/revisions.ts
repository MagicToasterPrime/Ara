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
import {
  isRevisionQuestionCorrect,
  normalizeTextForMatch,
} from "@/lib/question-grading";
import { hasUsableText, normalizePdfExtractedText } from "@/lib/pdf";
import { getSystemSettings } from "@/lib/system-settings";
import { getAllUeMetaMap } from "@/lib/ue-meta";
import { getUserAccountMeta } from "@/lib/user-schema";

export { normalizeTextForMatch };

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
  return normalizePdfExtractedText(raw)
    .replace(/^==(?:Start|End) of (?:OCR|PDF).*==$/gim, " ")
    .replace(/\[REP[ÈE]RE VISUEL[^\]]*\]/gi, " ")
    .replace(/\bPage\s+\d+(?:\s*\/\s*\d+)?\b/gi, " ")
    .replace(
      /^(?:oniris(?:\s+nantes)?|[eé]cole\s+nationale\s+v[eé]t[eé]rinaire[^.\n]*|©\s*oniris[^.\n]*|merci\s+(?:de|pour)\s+votre\s+attention\s*[!.]?|des\s+questions\s*\?)$/gim,
      " "
    )
    .replace(/^[ \t]*[^\n]{1,120}[.\u2026]{4,}\s*\d*[ \t]*$/gm, "")
    .replace(/\.{4,}\s*\d*/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const ADMIN_TOC_HEADING_RE =
  /(?:^|\n)\s*(?:#{1,4}\s*)?(?:(?:[IVX]{1,5}|[A-Z]|\d+)[.)-]?\s*)?(?:plan(?:\s+du\s+cours)?|sommaire|table\s+des\s+mati[eè]res|programme\s+du\s+cours)\b/i;
const ADMIN_OBJECTIVES_HEADING_RE =
  /(?:^|\n)\s*(?:#{1,4}\s*)?(?:(?:[IVX]{1,5}|[A-Z]|\d+)[.)-]?\s*)?(?:objectifs?\s+(?:p[eé]dagogiques?|d['’]apprentissage|du\s+cours|g[eé]n[eé]raux|sp[eé]cifiques)|pr[eé]-?requis|modalit[eé]s?\s+d['’][eé]valuation|contr[ôo]le\s+des\s+connaissances|acquis\s+d['’]apprentissage)\b/i;
const ADMIN_BIBLIO_HEADING_RE =
  /(?:^|\n)\s*(?:#{1,4}\s*)?(?:(?:[IVX]{1,5}|[A-Z]|\d+)[.)-]?\s*)?(?:bibliographie|r[eé]f[eé]rences?(?:\s+bibliographiques?)?|pour\s+en\s+savoir\s+plus|lectures?\s+conseill[eé]es?)\b/i;
const DOC_SEARCH_METHODOLOGY_RE =
  /(?<![a-zA-ZÀ-ÿ])(?:pubmed|hetop|mesh(?:\s+terms)?|sciencedirect|google\s+scholar|[eé]quation\s+de\s+recherche|portail\s+documentaire|m[eé]thode\s+boule\s+de\s+neige|requ[êe]te\s+(?:novice|avanc[eé]e)|texte\s+int[eé]gral)(?![a-zA-ZÀ-ÿ])/gi;
const SCIENTIFIC_RESULTS_SECTION_RE =
  /(?:^|\n)\s*(?:#{1,4}\s*)?(?:[IVX]+\.|[A-Z]\.|[1-9]\.)?\s*(?:r[eé]sultats|plantes?\s+et\s+toxines?|effets|sympt[ôo]mes|diagnostic|traitement|toxicit[eé]|physiopathologie|m[eé]canismes?)\b/im;

export function isAdministrativeOrTocText(
  text: string,
  pageNumber?: number
): boolean {
  const tocDotLines = text.match(/[^\n]{3,}[.\u2026]{5,}\s*\d+/g);
  if (tocDotLines && tocDotLines.length >= 3) return true;

  const cleaned = cleanChunkTextForAi(text);
  if (!cleaned || cleaned.length < 30) return true;

  const words = cleaned.split(/\s+/).filter(Boolean);
  const wordCount = words.length;
  const lines = cleaned
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const avgWordsPerLine = wordCount / Math.max(1, lines.length);

  // Page 1 cover / title / lecturer / promo metadata
  if (
    pageNumber === 1 &&
    wordCount < 45 &&
    /\b(?:oniris|env[a-z]*|enseignant|professeur|docteur|dr\.?|ma[îi]tre\s+de\s+conf|ue\s*\d+|semestre\s*\d+|promo(?:tion)?\s+20\d{2}|ann[eé]e\s+(?:universitaire|scolaire)|20\d{2}\s*[-–/]\s*20\d{2})\b/i.test(
      cleaned
    )
  ) {
    return true;
  }

  // Table of contents / Course outline slides
  if (
    ADMIN_TOC_HEADING_RE.test(cleaned) &&
    (wordCount < 150 || avgWordsPerLine < 11)
  ) {
    return true;
  }

  // Numbered outline without real prose sentences
  const outlineMatches = cleaned.match(
    /(?:^|\n)\s*(?:#{1,4}\s*)?(?:[IVX]{1,4}\.|[1-9]\.)\s+[^\n]{3,75}(?=\n|$)/g
  );
  if (outlineMatches && outlineMatches.length >= 4 && wordCount < 140) {
    const longProseSentences = cleaned
      .split(/(?<=[.!?])\s+/)
      .filter((s) => s.trim().length > 95);
    if (longProseSentences.length <= 1) {
      return true;
    }
  }

  // Bibliographic / literature search methodology pages (e.g. PubMed/HeTOP/MeSH reports)
  const docSearchHits = cleaned.match(DOC_SEARCH_METHODOLOGY_RE)?.length ?? 0;
  if (
    docSearchHits >= 2 &&
    wordCount < 280 &&
    !SCIENTIFIC_RESULTS_SECTION_RE.test(cleaned)
  ) {
    return true;
  }

  // Pedagogical objectives / prerequisites / evaluation rules
  const capableHits =
    cleaned.match(/\b(?:[êe]tre\s+capable\s+de|savoir\s+reconna[îi]tre|conna[îi]tre\s+les)\b/gi)
      ?.length ?? 0;
  if (
    ADMIN_OBJECTIVES_HEADING_RE.test(cleaned) &&
    (wordCount < 170 || capableHits >= 2)
  ) {
    return true;
  }
  if (capableHits >= 3 && wordCount < 180) {
    return true;
  }

  // Bibliography / References slides & web citation continuation pages
  const etAlHits = cleaned.match(/\bet\s+al\.?/gi)?.length ?? 0;
  const yearHits = cleaned.match(/\b(?:19|20)\d{2}\b/g)?.length ?? 0;
  if (ADMIN_BIBLIO_HEADING_RE.test(cleaned) && (wordCount < 220 || etAlHits >= 1)) {
    return true;
  }
  if (etAlHits >= 2 && yearHits >= 3 && wordCount < 200) {
    return true;
  }
  if (
    wordCount < 65 &&
    /\bdisponible\s+[àa]\s+l['’]adresse\s*:|(?:\[en\s+ligne\]|\[consult[eé]\s+le\b).*https?:\/\//i.test(
      cleaned
    )
  ) {
    return true;
  }

  // Telegraph / skeletal slides (< 20 words without units, full explanatory sentence, or real colon definition)
  const hasUnitValue =
    /\d+(?:[.,]\d+)?\s*(?:%|µm|um|mm|cm|ml|dl|l|µg|mg|g|kg|mmol|µmol|nmol|pmol|ui|meq|mmhg|bpm|°c)\b/i.test(
      cleaned
    );
  const hasExplanatorySentence = cleaned
    .split(/(?<=[.!?])\s+/)
    .some((s) => /[.!?]$/.test(s.trim()) && s.trim().split(/\s+/).length >= 10);
  const hasColonDefinition = /[^:\n]{3,}:\s+(?!https?:\/\/)\S+(?:\s+\S+){4,}/.test(
    cleaned
  );
  if (
    wordCount < 20 &&
    !hasUnitValue &&
    !hasExplanatorySentence &&
    !hasColonDefinition
  ) {
    return true;
  }

  // Implicit outline / bare diagram title lists
  if (wordCount < 70 && lines.length >= 3) {
    const shortHeadingLines = lines.filter((line) => {
      const strippedLine = line.replace(/^#{1,4}\s+/, "");
      const lw = strippedLine.split(/\s+/).filter(Boolean).length;
      const endsWithPunct = /[.!?]$/.test(strippedLine);
      const lineHasUnit =
        /\d+(?:[.,]\d+)?\s*(?:%|µm|um|mm|cm|ml|dl|l|µg|mg|g|kg|mmol|µmol|nmol|pmol|ui|meq|mmhg|bpm|°c)\b/i.test(
          strippedLine
        );
      return lw <= 7 && !endsWithPunct && !lineHasUnit;
    });
    if (shortHeadingLines.length / lines.length >= 0.75) {
      return true;
    }
  }

  return false;
}

export function scoreChunkPedagogicalQuality(
  text: string,
  pageNumber?: number
): number {
  const cleaned = cleanChunkTextForAi(text);
  if (!cleaned || isAdministrativeOrTocText(cleaned, pageNumber)) {
    return -50;
  }
  const words = cleaned.split(/\s+/).filter(Boolean).length;
  if (words < 25) return -20;

  let score = words < 45 ? -5 : Math.min(20, Math.floor(words / 25));

  if (
    /\d+(?:[.,]\d+)?\s*(?:%|µm|um|mm|cm|ml|dl|l|µg|mg|g|kg|mmol|µmol|nmol|pmol|ui|mEq|mmHg|bpm|°c)\b/i.test(
      cleaned
    )
  ) {
    score += 6;
  }
  if (
    /\b(?:provoque|entra[îi]ne|induit|inhibe|active|stimule|r[eé]gule|s[eé]cr[eè]te|synth[eé]tise|m[eé]tabolise|transforme|catalyse|augmente|diminue|diagnostique|sympt[ôo]me|traitement|posologie|agent\s+pathog[eè]ne|m[eé]canisme|d[eé]finition)\b/i.test(
      cleaned
    )
  ) {
    score += 5;
  }
  if (/:/.test(cleaned) && !ADMIN_TOC_HEADING_RE.test(cleaned)) {
    score += 2;
  }
  if (
    words < 50 &&
    /\b(?:diapo|cas\s+clinique\s+suivant|pause|exercice\s+d['’]application)\b/i.test(
      cleaned
    )
  ) {
    score -= 10;
  }
  const docSearchHits = cleaned.match(DOC_SEARCH_METHODOLOGY_RE)?.length ?? 0;
  if (docSearchHits >= 2) {
    score -= 25;
  }

  return score;
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
    if (
      /^(?:sommaire|table\s+des\s+mati[eè]res|plan(?:\s+du\s+cours)?|objectifs?|pr[eé]-?requis|bibliographie|r[eé]f[eé]rences|export[eé]\s+le|g[eé]n[eé]r[eé]\s+par|fin\b)/i.test(
        unit
      )
    ) {
      score -= 8;
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

export const META_APOLOGY_OR_HOLLOW_RE =
  /\b(?:le\s+document|l['’]extrait|le\s+texte|le\s+cours|la\s+diapositive|ce\s+passage|le\s+polycopi[eé])\s+(?:mentionne|[eé]voque|indique|aborde|cite|pr[eé]sente\s+un\s+rappel)\b|\bsans\s+(?:plus\s+de\s+d[eé]tails|d[eé]tailler\s+davantage|pr[eé]ciser\s+davantage|autre\s+pr[eé]cision|donner\s+de\s+d[eé]tails)\b|\bd[eé]tails?\s+(?:sp[eé]cifiques?\s+)?[^.]{0,45}ne\s+sont\s+pas\s+(?:fournis?|pr[eé]cis[eé]s?|d[eé]taill[eé]s?|mentionn[eé]s?)\b|\bn['’]est\s+pas\s+(?:fourni|d[eé]taill[eé]|pr[eé]cis[eé]|explicit[eé])e?\s+dans\s+(?:l['’]extrait|le\s+document|le\s+texte|le\s+cours)\b|\best\s+abord[eé]e?,?\s+mais\s+les\s+d[eé]tails\b|\bil\s+s['’]agit\s+d['’]une\s+introduction\s+g[eé]n[eé]rale\s+[àa]\b/i;

export function isMetaApologyOrHollowText(text?: string | null): boolean {
  if (!text) return false;
  const normalized = text.replace(/\*\*/g, "").replace(/\s+/g, " ").trim();
  if (!normalized) return false;
  return META_APOLOGY_OR_HOLLOW_RE.test(normalized);
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
  /quel\s+point\s+essentiel\s+faut-il\s+retenir\s+concernant/i,
  /citez\s+le\s+terme\s+essentiel\s+d[eé]fini\s+en\s+p\.\d+/i,
  /quels\s+termes\s+cl[eé]s\s+appartiennent\s+directement\s+aux\s+m[eé]canismes/i,
  /param[eè]tre\s+non\s+mentionn[eé]|crit[eè]re\s+d['’]un\s+autre\s+module|caract[eé]ristique\s+[eé]trang[eè]re/i,
  /^(?:concept|notion|terme(?:\s+clinique)?|option|proposition)\s*\d+$/i,
  META_APOLOGY_OR_HOLLOW_RE,
];

const BLIND_MEDIA_OR_CONTEXT_RE =
  /\b(?:sur|dans|d['’]apr[eè]s|selon|voir)\s+(?:(?:la|le|ce|cette|les|l['’])\s+)?(?:figure(?:\s*\d+)?|fig\.?\s*\d*|tableau(?!\s+(?:clinique|l[eé]sionnel|symptomatique|biologique|h[eé]matologique|d['’]intoxication|de\s+choc))(?:\s*\d+)?|tab\.?\s*\d*|sch[eé]ma(?:\s*\d+)?|diapositive(?:\s*\d+)?|diapo(?:\s*\d+)?|photo(?:\s*\d+)?|image(?!\s+(?:radiographique|[eé]chographique|histologique))(?:\s*\d+)?|graphique(?:\s*\d+)?|extrait(?:\s*\d+)?|texte\s+(?:ci-?(?:dessus|dessous|contre)|fourni)|document\s+fourni|ce\s+polycopi[eé])\b|\b(?:ci-dessus|ci-dessous|ci-contre)\b/i;

const ADMIN_QUESTION_TOPIC_RE =
  /(?<![a-zA-ZÀ-ÿ])(?:objectif(?:s)?\s+p[eé]dagogique|objectif(?:s)?\s+d['’]apprentissage|plan\s+du\s+cours|sommaire|table\s+des\s+mati[eè]res|enseignant|professeur|auteur\s+du\s+cours|responsable\s+d['’]ue|modalit[eé]s?\s+d['’][eé]valuation|contr[ôo]le\s+continu|pr[eé]-?requis|bibliographie|volume\s+horaire|cr[eé]dits\s+ects|pubmed|hetop|termes?\s+mesh|mesh\s+terms|sciencedirect|google\s+scholar|[eé]quation\s+de\s+recherche|portail\s+documentaire|requ[êe]te\s+bibliographique|m[eé]thode\s+boule\s+de\s+neige)(?![a-zA-ZÀ-ÿ])/i;

export const CORRUPTED_PDF_CHAR_RE = /[\u01AF\u01B0\uE000-\uF8FF]/;

const META_CATCHALL_OPTION_RE =
  /^(?:aucune\s+de\s+ces\s+r[eé]ponses|toutes\s+les\s+r[eé]ponses|toutes\s+ces\s+propositions|toutes\s+les\s+propositions|cela\s+d[eé]pend|impossible\s+de\s+savoir|ne\s+se\s+prononce\s+pas|vrai|faux|oui|non)\b/i;

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
  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt || trimmedPrompt.length < 10) {
    return true;
  }
  if (
    hasGenericPlaceholderLeak(trimmedPrompt) ||
    isMetaApologyOrHollowText(trimmedPrompt) ||
    CORRUPTED_PDF_CHAR_RE.test(trimmedPrompt)
  ) {
    return true;
  }
  if (BLIND_MEDIA_OR_CONTEXT_RE.test(trimmedPrompt)) {
    return true;
  }
  if (ADMIN_QUESTION_TOPIC_RE.test(trimmedPrompt)) {
    return true;
  }
  if (
    trimmedPrompt.length < 110 &&
    /\b(?:quel\s+est\s+l['’][âa]ge\s+du|dans\s+ce(?:t|tte)?\s+(?:cas\s+clinique|exemple|exercice))\b/i.test(
      trimmedPrompt
    )
  ) {
    return true;
  }
  if (answerOrBack) {
    if (
      hasGenericPlaceholderLeak(answerOrBack) ||
      isMetaApologyOrHollowText(answerOrBack) ||
      CORRUPTED_PDF_CHAR_RE.test(answerOrBack)
    ) {
      return true;
    }
    if (BLIND_MEDIA_OR_CONTEXT_RE.test(answerOrBack)) {
      return true;
    }
  }
  if (
    /correspond exactement au cours|directement tir[eé]e du cours|quelle phrase figure dans le cours|notion cl[eé].*quel [eé]l[eé]ment/i.test(
      trimmedPrompt
    )
  ) {
    return true;
  }
  if (!options || options.length === 0) return false;
  if (options.length < 4) return true;

  const normOptions: string[] = [];
  let longOptionCount = 0;

  for (const opt of options) {
    const clean = opt.trim();
    if (!clean || (clean.length < 2 && !/^\d$/.test(clean))) {
      return true;
    }
    if (
      hasGenericPlaceholderLeak(clean) ||
      isMetaApologyOrHollowText(clean) ||
      CORRUPTED_PDF_CHAR_RE.test(clean)
    ) {
      return true;
    }
    if (META_CATCHALL_OPTION_RE.test(clean)) {
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
    normOptions.push(normalizeTextForMatch(clean));
  }

  if (new Set(normOptions).size < options.length) {
    return true;
  }

  for (let i = 0; i < normOptions.length; i += 1) {
    const shorter = normOptions[i];
    if (shorter.length <= 25) continue;
    const escaped = shorter.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const wordRe = new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`);
    for (let j = 0; j < normOptions.length; j += 1) {
      if (i !== j && normOptions[j].length > shorter.length && wordRe.test(normOptions[j])) {
        return true;
      }
    }
  }

  return longOptionCount >= 2;
}

export function reconcileMcqCorrectIndices(
  options: string[],
  rawIndices: number[],
  explanation?: string,
  type: "QCU" | "QCM" = "QCU",
  prompt?: string
): number[] {
  if (!Array.isArray(options) || options.length !== 4 || !Array.isArray(rawIndices)) {
    return [];
  }

  let indices = rawIndices.filter(
    (n) => typeof n === "number" && Number.isInteger(n)
  );
  if (
    indices.some((n) => n === 4) &&
    !indices.includes(0) &&
    indices.every((n) => n >= 1 && n <= 4)
  ) {
    indices = indices.map((n) => n - 1);
  }

  const valid = Array.from(
    new Set(indices.filter((i) => i >= 0 && i < options.length))
  ).sort((a, b) => a - b);

  if (type === "QCM") {
    return valid;
  }

  if (valid.length === 0) return [];
  let chosenIdx = valid[0];

  if (explanation && explanation.trim()) {
    const normExp = normalizeTextForMatch(explanation);
    const matchedIndices: number[] = [];
    for (let i = 0; i < options.length; i += 1) {
      const normOpt = normalizeTextForMatch(options[i]);
      if (normOpt.length < 4) continue;
      const escaped = normOpt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const hitRe = new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`);
      const negatedRe = new RegExp(
        `(?:pas|ni|non|faux|incorrect|errone|contrairement\\s+a|au\\s+lieu\\s+d[e']?)\\s+(?:l[ea]s?\\s+|l['’]?\\s*)?${escaped}`
      );
      if (hitRe.test(normExp) && !negatedRe.test(normExp)) {
        matchedIndices.push(i);
      }
    }
    if (matchedIndices.length === 1 && matchedIndices[0] !== chosenIdx) {
      chosenIdx = matchedIndices[0];
    }
  }

  if (prompt && prompt.trim()) {
    const normPrompt = normalizeTextForMatch(prompt);
    const normChosen = normalizeTextForMatch(options[chosenIdx]);
    if (normChosen.length >= 6 && !/^\d+(?:\s+\d+)*$/.test(normChosen)) {
      const escapedChosen = normChosen.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const chosenInPrompt = new RegExp(`(?:^|\\s)${escapedChosen}(?:$|\\s)`).test(
        normPrompt
      );
      if (chosenInPrompt) {
        const anyDistractorInPrompt = options.some((opt, idx) => {
          if (idx === chosenIdx) return false;
          const normDistractor = normalizeTextForMatch(opt);
          if (normDistractor.length < 4) return false;
          const escapedDistractor = normDistractor.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&"
          );
          return new RegExp(`(?:^|\\s)${escapedDistractor}(?:$|\\s)`).test(
            normPrompt
          );
        });
        if (!anyDistractorInPrompt) {
          return [];
        }
      }
    }
  }

  const chosenLen = options[chosenIdx].trim().length;
  const distractorLens = options
    .filter((_, i) => i !== chosenIdx)
    .map((o) => o.trim().length);
  const avgDistractorLen =
    distractorLens.reduce((sum, n) => sum + n, 0) /
    Math.max(1, distractorLens.length);

  if (chosenLen > avgDistractorLen * 2.2 && chosenLen > 48) {
    return [];
  }

  return [chosenIdx];
}

const VALID_VET_MENT_NOUNS = new Set([
  "element",
  "complement",
  "supplement",
  "cement",
  "tegument",
  "ligament",
  "segment",
  "medicament",
  "ferment",
  "aliment",
  "excrement",
  "sediment",
  "traitement",
  "vomissement",
  "saignement",
  "avortement",
  "allaitement",
  "epanchement",
  "gonflement",
  "accouchement",
  "tremblement",
  "engorgement",
  "compartiment",
  "recouvrement",
  "relachement",
  "decollement",
  "remaniement",
  "acheminement",
]);

const GENERIC_QROC_ANSWERS = new Set([
  "oui",
  "non",
  "vrai",
  "faux",
  "aucun",
  "aucune",
  "plusieurs",
  "variable",
  "variables",
  "important",
  "importante",
  "importants",
  "importantes",
  "essentiel",
  "essentielle",
  "general",
  "generale",
  "divers",
  "diverses",
  "inconnu",
  "possible",
  "impossible",
  "obligatoire",
  "facultatif",
  "chapitre",
  "cours",
  "page",
  "figure",
  "tableau",
  "schema",
  "concept",
  "notion",
]);

function isGenericAdverbInMent(normalizedWord: string): boolean {
  if (!normalizedWord.endsWith("ment")) return false;
  if (VALID_VET_MENT_NOUNS.has(normalizedWord)) return false;
  return (
    /(?:amment|emment|ellement|iellement|uellement|iquement|alement|ativement|itivement|eusement|erement|ablement|iblement|tement|nement|sement|vement|dement|gement|rement|iment|ement)$/.test(
      normalizedWord
    )
  );
}

export function isValidQrocQuestion(
  prompt: string,
  correctAnswer: string
): boolean {
  const trimmed = correctAnswer.trim();
  if (trimmed.length < 2 || trimmed.length > 50) return false;
  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 5) return false;

  const normAns = normalizeTextForMatch(trimmed);
  if (!normAns) return false;
  if (GENERIC_QROC_ANSWERS.has(normAns)) return false;
  if (words.length === 1 && isGenericAdverbInMent(normAns)) return false;

  if (normAns.length >= 4) {
    const normPrompt = normalizeTextForMatch(prompt);
    const escaped = normAns.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?:^|\\s)${escaped}(?:$|\\s)`).test(normPrompt)) {
      return false;
    }
  }

  return true;
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

const SLIDE_STRUCTURE_TERM_RE =
  /^(?:figure|fig\.?|tableau|tab\.?|sch[eé]ma|diapo|diapositive|photo|image|cas(?:\s+clinique)?|question|r[eé]ponse|objectif(?:s)?|conclusion|introduction|r[eé]sum[eé]|bilan|rappel|d[eé]finition|exemple|ex\.?|note|nb|attention|important|r[eè]gle|[eé]tape|partie|chapitre|module|enseignant|professeur|auteur|source|r[eé]f[eé]rence|dur[eé]e|date|plan|sommaire)\b/i;

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
    if (isAdministrativeOrTocText(cleaned, chunk.pageNumber)) continue;
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
          !SLIDE_STRUCTURE_TERM_RE.test(term) &&
          !ADMIN_QUESTION_TOPIC_RE.test(term) &&
          !ADMIN_QUESTION_TOPIC_RE.test(explanation) &&
          !seenTerms.has(key)
        ) {
          seenTerms.add(key);
          definitions.push({ term, explanation, chunk });
        }
      }

      // 2. Quantitative facts with percentages, scientific units, or genuine historical dates
      const isBiblioOrAdmin =
        /\b(?:et al\.?|ed\.?|[eé]dition|press|wiley|elsevier|masson|saunders|springer|pearson|physiologie humaine|bibliographie|r[eé]f[eé]rences)\b/i.test(
          line
        ) ||
        /\b(?:ue\s*\d+|202[4-9])\b/i.test(line) ||
        /\b(?:chien|chat|cheval|bovin|vache|veau|poulain|animal|patient|sujet|[âa]g[eé])\s+de\s+\d+/i.test(
          line
        ) ||
        /\b(?:dur[eé]e|cours|s[eé]ance|examen|partiel|td|tp|semestre|heure)\b/i.test(
          line
        );

      const pctMatch = !isBiblioOrAdmin
        ? line.match(
            /((?:plus de|moins de|environ|pr[eè]s de|entre\s+\d+\s+et\s+)?\d+(?:[.,]\d+)?\s*%)/i
          )
        : null;
      const hasHistoricalContext =
        /\b(?:cr[eé][eé]|cr[eé][eé]e|fond[eé]|fond[eé]e|d[eé]couvert|d[eé]couverte|institu[eé]|loi|d[eé]cret|ordonnance|si[eè]cle|premi[eè]re|premier|[eé]cole|r[eé]volution|naissance)\b/i.test(
          line
        );
      const yearMatch =
        !pctMatch && !isBiblioOrAdmin && hasHistoricalContext
          ? line.match(/\b(1[6-9]\d{2}|20[0-1]\d)\b/)
          : null;
      const unitMatch =
        !pctMatch && !yearMatch && !isBiblioOrAdmin
          ? line.match(
              /(\d+(?:[.,]\d+)?(?:\s*(?:à|-|–)\s*\d+(?:[.,]\d+)?)?\s*(?:µm|um|mm|cm|ml|dl|l|µg|mg|g|kg|mmol|µmol|nmol|pmol|ui|meq|mmhg|bpm|°c|g\/l|mg\/dl|mg\/kg|mmol\/l))\b/i
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

const FRENCH_STOPWORDS = new Set([
  "alors", "apres", "assez", "aucun", "aucune", "aussi", "autant", "autres",
  "autre", "avant", "avec", "avoir", "beaucoup", "bien", "bientot", "car",
  "ceci", "cela", "celle", "celles", "celui", "cependant", "certain",
  "certaine", "certaines", "certains", "cette", "ceux", "chaque", "chez",
  "comme", "comment", "concerne", "concernant", "contre", "cours", "dans",
  "davantage", "debut", "dedans", "dehors", "deja", "depuis", "derniere",
  "derniers", "desormais", "dessous", "dessus", "devant", "devoir", "differe",
  "different", "differente", "differentes", "differents", "diverse", "diverses",
  "divers", "doit", "doivent", "donc", "donnees", "donner", "dont", "durant",
  "effet", "egalement", "elle", "elles", "encore", "enfin", "ensemble",
  "ensuite", "entre", "environ", "envoyer", "essentiel", "essentielle",
  "essentiellement", "etait", "etaient", "etant", "etape", "etapes", "etat",
  "etats", "etre", "exemple", "exemples", "existe", "existent", "facile",
  "faible", "faire", "fait", "faites", "faits", "falloir", "figure", "fois",
  "fonction", "forme", "formes", "fort", "forte", "general", "generale",
  "generales", "generaux", "generalement", "grace", "grand", "grande",
  "grandes", "grands", "groupe", "haut", "haute", "heure", "heures",
  "important", "importante", "importantes", "importants", "indique", "indiquer",
  "inverse", "jamais", "jour", "jours", "jusqu", "jusque", "laquelle",
  "lequel", "lesquels", "lesquelles", "leur", "leurs", "lieu", "loin", "lors",
  "lorsque", "maintenant", "mais", "malgre", "maniere", "meme", "memes",
  "merci", "mesure", "mettre", "mieux", "milieu", "minimum", "maximum",
  "modele", "moins", "moment", "moyen", "moyenne", "nature", "necessaire",
  "niveau", "nombre", "nombreux", "nombreuses", "normal", "normale",
  "notamment", "note", "notion", "notions", "nous", "nouveau", "nouvelle",
  "nouvelles", "nouveaux", "objectif", "objectifs", "objet", "obtenir",
  "ordre", "page", "pages", "parce", "parmi", "part", "partie", "parties",
  "particulier", "particuliere", "particulierement", "partir", "passe",
  "pendant", "permet", "permettant", "permettre", "personne", "petit",
  "petite", "peut", "peuvent", "plan", "plupart", "plus", "plusieurs",
  "plutot", "point", "points", "porte", "porter", "possible", "possibles",
  "pour", "pourquoi", "pourtant", "pouvoir", "premier", "premiere",
  "premieres", "premiers", "prend", "prendre", "presence", "present",
  "presente", "presentent", "presenter", "presque", "prevoir", "principal",
  "principale", "principales", "principaux", "principalement", "probleme",
  "prochain", "prochaine", "produit", "produits", "propre", "propres",
  "puis", "puisque", "quand", "quant", "quasiment", "quel", "quelle",
  "quelles", "quels", "quelque", "quelques", "question", "questions",
  "raison", "rapport", "rapporter", "recemment", "recherche", "regle",
  "regles", "relatif", "relative", "relativement", "remarque", "reponse",
  "reponses", "reste", "rester", "resultat", "resultats", "retenir",
  "resume", "role", "sans", "sauf", "savoir", "schema", "schemas", "second",
  "seconde", "selon", "semblable", "semble", "semaine", "semaines",
  "serait", "seront", "seul", "seule", "seulement", "si", "signifie",
  "simple", "simplement", "sinon", "situation", "soient", "soit", "sommaire",
  "sont", "souvent", "sous", "souhaite", "source", "sources", "special",
  "specifique", "specifiques", "stade", "stades", "structure", "structures",
  "suite", "suivant", "suivante", "suivantes", "suivants", "suivre", "sujet",
  "superieur", "superieure", "surtout", "systeme", "tableau", "tableaux",
  "tandis", "tant", "tard", "tel", "telle", "telles", "tels", "temps",
  "terme", "termes", "texte", "theme", "toujours", "tous", "tout", "toute",
  "toutefois", "toutes", "travers", "tres", "trois", "trop", "trouver",
  "type", "types", "unique", "uniquement", "unite", "utiliser", "utilise",
  "utilises", "utilisee", "utilisees", "valeur", "valeurs", "variable",
  "variables", "vers", "voici", "voila", "voir", "votre", "vous", "vrai",
  "chapitre", "chapitres", "module", "polycopie", "diapositive", "diapo",
  "enseignant", "professeur", "etudiant", "etudiants", "vet", "oniris",
]);

function extractCandidateTerms(text: string): string[] {
  const words = cleanChunkTextForAi(text)
    .replace(/[.,;:!?()[\]"'«»]/g, " ")
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 6 && /^[a-zA-ZÀ-ÿ-]+$/.test(w))
    .filter((w) => {
      const norm = normalizeTextForMatch(w);
      if (!norm || FRENCH_STOPWORDS.has(norm)) return false;
      if (isGenericAdverbInMent(norm)) return false;
      return true;
    });

  return Array.from(new Set(words));
}

function collectRealTermDistractors(
  excludeNormalized: Set<string>,
  pools: Array<string[]>,
  needed = 3
): string[] {
  const picked: string[] = [];
  for (const pool of pools) {
    for (const candidate of pool) {
      const clean = candidate.trim();
      const norm = normalizeTextForMatch(clean);
      if (clean.length < 3 || !norm || excludeNormalized.has(norm)) continue;
      excludeNormalized.add(norm);
      picked.push(clean);
      if (picked.length >= needed) return picked;
    }
  }
  return picked;
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

  const allTermPool = extractCandidateTerms(
    otherChunks.map((c) => c.content).join(" ")
  );

  const chunkDef =
    definitions.find((d) => d.chunk.documentId === chunk.documentId) ||
    definitions[0];
  if (chunkDef) {
    const usedNorms = new Set([normalizeTextForMatch(chunkDef.term)]);
    const distractors = collectRealTermDistractors(
      usedNorms,
      [definitions.map((d) => d.term), allTermPool],
      3
    );
    if (distractors.length === 3) {
      const shuffled = shuffleOptionsWithIndices(
        [chunkDef.term, ...distractors],
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
  }

  const sents = splitCleanSentences(chunk.content);
  const targetSent =
    sents.find((s) => extractCandidateTerms(s).length > 0) ||
    sents[0] ||
    cleanChunkTextForAi(chunk.content).slice(0, 140);
  const terms = extractCandidateTerms(targetSent);
  const fallbackTerms =
    terms.length > 0 ? terms : extractCandidateTerms(chunk.content);
  const answerTerm = fallbackTerms[0];

  if (answerTerm) {
    const masked = targetSent
      .replace(
        new RegExp(
          `\\b${answerTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
          "i"
        ),
        "[ ... ]"
      )
      .slice(0, 140);
    const usedNorms = new Set([normalizeTextForMatch(answerTerm)]);
    const altTerms = collectRealTermDistractors(
      usedNorms,
      [allTermPool, extractCandidateTerms(chunk.content)],
      3
    );
    if (masked.includes("[ ... ]") && altTerms.length === 3) {
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
  }

  return buildFallbackQROC(chunk);
}

function buildFallbackQCM(
  chunk: SampledChunk,
  otherChunks: SampledChunk[]
): RevisionQuestion {
  const { definitions } = extractCourseFacts([chunk]);
  const { definitions: otherDefs } = extractCourseFacts(
    otherChunks.filter((c) => c.id !== chunk.id).slice(0, 12)
  );

  if (definitions.length >= 2 && otherDefs.length >= 2) {
    const rightA = `${definitions[0].term} : ${definitions[0].explanation.slice(0, 65)}`;
    const rightB = `${definitions[1].term} : ${definitions[1].explanation.slice(0, 65)}`;
    const wrongPool = otherDefs
      .filter(
        (d) =>
          normalizeTextForMatch(d.term) !== normalizeTextForMatch(definitions[0].term) &&
          normalizeTextForMatch(d.term) !== normalizeTextForMatch(definitions[1].term)
      )
      .slice(0, 2)
      .map((d) => `${d.term} : ${d.explanation.slice(0, 65)}`);

    if (wrongPool.length === 2) {
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
        prompt: `Parmi ces notions issues du module « ${chunk.chapterTitle} », lesquelles correspondent aux définitions de cette partie ?`,
        options: shuffled.options,
        correctIndices: shuffled.correctIndices,
        explanation: `Les affirmations exactes proviennent de ${chunk.documentTitle} (p.${chunk.pageNumber}).`,
        generatedByAi: false,
      };
    }
  }

  const terms = extractCandidateTerms(chunk.content);
  const termSet = new Set(terms.map((t) => normalizeTextForMatch(t)));
  const otherTerms = extractCandidateTerms(
    otherChunks
      .filter((c) => c.documentId !== chunk.documentId)
      .map((c) => c.content)
      .join(" ")
  ).filter((t) => !termSet.has(normalizeTextForMatch(t)));

  if (terms.length >= 2 && otherTerms.length >= 2) {
    const shuffled = shuffleOptionsWithIndices(
      [terms[0], terms[1], otherTerms[0], otherTerms[1]],
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
      prompt: `Quelles notions sont directement abordées dans « ${chunk.chapterTitle} » (${chunk.documentTitle}, p.${chunk.pageNumber}) ?`,
      options: shuffled.options,
      correctIndices: shuffled.correctIndices,
      explanation: `Notions issues de ${chunk.documentTitle} (page ${chunk.pageNumber}).`,
      generatedByAi: false,
    };
  }

  return buildFallbackQCU(chunk, otherChunks);
}

function buildFallbackQROC(chunk: SampledChunk): RevisionQuestion {
  const { definitions } = extractCourseFacts([chunk]);
  const validDef = definitions.find((d) =>
    isValidQrocQuestion(
      `Quel terme ou notion correspond à : « ${d.explanation.slice(0, 145)} » ?`,
      d.term
    )
  );
  if (validDef) {
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
      prompt: `Quel terme ou notion correspond à la définition suivante : « ${validDef.explanation.slice(0, 145)} » ?`,
      correctAnswer: validDef.term,
      acceptedKeywords: [validDef.term, ...extractCandidateTerms(validDef.term)],
      explanation: `${validDef.term} : ${validDef.explanation} (${chunk.documentTitle}, p.${chunk.pageNumber}).`,
      generatedByAi: false,
    };
  }

  const sentences = splitCleanSentences(chunk.content);
  for (const s of sentences) {
    const candidates = extractCandidateTerms(s).sort((a, b) => b.length - a.length);
    for (const term of candidates) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const masked = s
        .replace(new RegExp(`\\b${escaped}\\b`, "i"), "[ ... ]")
        .slice(0, 160);
      if (!masked.includes("[ ... ]")) continue;
      const qPrompt = `Quel terme scientifique complète exactement : « ${masked} » ?`;
      if (!isValidQrocQuestion(qPrompt, term)) continue;
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
        prompt: qPrompt,
        correctAnswer: term,
        acceptedKeywords: [term, ...candidates.slice(0, 4)],
        explanation: `Réponse attendue : « ${term} » (${chunk.documentTitle}, p.${chunk.pageNumber}).`,
        generatedByAi: false,
      };
    }
  }

  return buildFallbackFlashcard(chunk);
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
    if (isLowQualityExcerptQuestion(front, undefined, back)) return;
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
    if (isAdministrativeOrTocText(c.content, c.pageNumber)) continue;
    const sents = splitCleanSentences(c.content);
    for (const s of sents) {
      if (out.length >= targetCount) break;
      const terms = extractCandidateTerms(s).sort((a, b) => b.length - a.length);
      if (terms.length === 0) continue;
      const term = terms[0];
      tryPush(
        `Quel rôle ou mécanisme caractérise « ${term} » dans « ${c.chapterTitle} » ?`,
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
  const pedagogicalChunks = chunks.filter(
    (c) => !isAdministrativeOrTocText(c.content, c.pageNumber)
  );
  const allTerms = extractCandidateTerms(
    (pedagogicalChunks.length > 0 ? pedagogicalChunks : chunks)
      .map((c) => c.content)
      .join(" ")
  );

  const pushQuestion = (q: RevisionQuestion) => {
    const key = q.prompt.toLowerCase().slice(0, 60);
    if (seenPrompts.has(key) || out.length >= targetCount) return;
    if (
      isLowQualityExcerptQuestion(
        q.prompt,
        q.options,
        q.correctAnswer || q.flashcardBack
      )
    ) {
      return;
    }
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
    const qrocPrompt = `Quel concept précis correspond à : « ${def.explanation.slice(0, 140)} » ?`;

    if (i % 3 === 2 && isValidQrocQuestion(qrocPrompt, def.term)) {
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
        prompt: qrocPrompt,
        correctAnswer: def.term,
        acceptedKeywords: [def.term, ...extractCandidateTerms(def.term)],
        explanation: `${def.term} : ${def.explanation} (${def.chunk.documentTitle}, p.${def.chunk.pageNumber}).`,
        generatedByAi: false,
      });
    } else {
      const usedNorms = new Set([normalizeTextForMatch(def.term)]);
      const distractors = collectRealTermDistractors(
        usedNorms,
        [
          definitions
            .filter((d) => normalizeTextForMatch(d.term) !== normalizeTextForMatch(def.term))
            .map((d) => d.term),
          allTerms,
        ],
        3
      );
      if (distractors.length < 3) continue;
      const shuffled = shuffleOptionsWithIndices([def.term, ...distractors], [0]);
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

  for (const chunk of pedagogicalChunks) {
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
      const usedNorms = new Set([normalizeTextForMatch(answer)]);
      const opts = collectRealTermDistractors(usedNorms, [allTerms], 3);
      if (opts.length < 3) continue;
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

RÈGLES PÉDAGOGIQUES ET JSON STRICTES (4 champs racines : "qcu", "qcm", "qroc", "flashcard") :
1. AUTONOMIE TOTALE OBLIGATOIRE : chaque question doit être compréhensible seule sans voir le polycopié. INTERDIT de faire référence à une figure, un tableau, un schéma, une diapo, une image, un graphique, un extrait ou à un cas clinique incomplet (ex. « quel est l'âge du chien ? »).
2. ZÉRO QUESTION ADMINISTRATIVE : interdit d'interroger sur le plan du cours, le sommaire, les objectifs pédagogiques, les pré-requis, les modalités d'évaluation, le nom de l'enseignant ou la bibliographie.
3. INTERDIT de recopier des phrases complètes du polycopié en propositions, ni d'utiliser « Aucune de ces réponses », « Toutes les réponses », « Vrai/Faux ». Les 4 options d'un QCU/QCM doivent être distinctes et de longueur comparable.
4. Champ "qcu" (basé sur l'EXTRAIT 1) :
   - "prompt" : question directe, autonome et précise testant un chiffre, un seuil, une définition ou un mécanisme réel de l'extrait 1.
   - "options" : tableau de 4 propositions courtes (1 à 8 mots chacune), homogènes, plausibles, sans préfixe alphabétique ni répétition.
   - "correctIndices" : tableau contenant l'unique indice base-0 (0, 1, 2 ou 3) de la bonne réponse, cohérent avec l'explication.
   - "explanation" : justification factuelle concise tirée de l'extrait 1.
5. Champ "qcm" (basé sur l'EXTRAIT 2) :
   - "prompt" : question à choix multiples autonome et contextualisée sur le mécanisme ou la notion de l'extrait 2.
   - "options" : tableau de 4 propositions courtes (1 à 10 mots chacune), sans préfixe alphabétique ni répétition.
   - "correctIndices" : tableau contenant exactement 2 ou 3 indices base-0 (0 à 3) des propositions exactes.
   - "explanation" : justification factuelle concise tirée de l'extrait 2.
6. Champ "qroc" (basé sur l'EXTRAIT 3) :
   - "prompt" : question ouverte courte et précise appelant un terme scientifique exact, une molécule, un organe ou une valeur (sans révéler la réponse dans l'énoncé).
   - "correctAnswer" : réponse exacte attendue en 1 à 4 mots scientifiques issus de l'extrait 3 (jamais un adverbe ni « oui/non »).
   - "acceptedKeywords" : liste de mots-clés scientifiques et synonymes pertinents tirés de l'extrait 3.
   - "explanation" : justification factuelle concise tirée de l'extrait 3.
7. Champ "flashcard" (basé sur l'EXTRAIT 4) :
   - "prompt" : question recto directe et autonome en une seule phrase portant sur un fait précis de l'extrait 4.
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
        !hasGenericPlaceholderLeak(parsed.qcu.explanation)
      ) {
        const cleanOpts = parsed.qcu.options.map((o) =>
          String(o).replace(/^[A-D]\s*[.)\]:-]\s+/i, "").trim()
        );
        const reconciledIdx = reconcileMcqCorrectIndices(
          cleanOpts,
          parsed.qcu.correctIndices,
          parsed.qcu.explanation,
          "QCU",
          parsed.qcu.prompt
        );
        if (
          reconciledIdx.length === 1 &&
          !isLowQualityExcerptQuestion(parsed.qcu.prompt, cleanOpts)
        ) {
          const shuffledQcu = shuffleOptionsWithIndices(cleanOpts, reconciledIdx);
          result.qcu = {
            prompt: parsed.qcu.prompt.trim(),
            options: shuffledQcu.options,
            correctIndices: shuffledQcu.correctIndices,
            explanation: (parsed.qcu.explanation || "").trim(),
            generatedByAi: true,
          };
        }
      }

      if (
        parsed.qcm?.prompt &&
        Array.isArray(parsed.qcm.options) &&
        parsed.qcm.options.length === 4 &&
        Array.isArray(parsed.qcm.correctIndices) &&
        !hasGenericPlaceholderLeak(parsed.qcm.explanation)
      ) {
        const cleanOpts = parsed.qcm.options.map((o) =>
          String(o).replace(/^[A-D]\s*[.)\]:-]\s+/i, "").trim()
        );
        const validIndices = reconcileMcqCorrectIndices(
          cleanOpts,
          parsed.qcm.correctIndices,
          parsed.qcm.explanation,
          "QCM",
          parsed.qcm.prompt
        );

        if (
          validIndices.length >= 2 &&
          !isLowQualityExcerptQuestion(parsed.qcm.prompt, cleanOpts)
        ) {
          const shuffledQcm = shuffleOptionsWithIndices(cleanOpts, validIndices);
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
        isValidQrocQuestion(parsed.qroc.prompt, parsed.qroc.correctAnswer) &&
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
  skipAi?: boolean;
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

  const allPool = shuffle(Array.from(chunkMap.values())).sort(
    (a, b) =>
      scoreChunkPedagogicalQuality(b.content, b.pageNumber) -
      scoreChunkPedagogicalQuality(a.content, a.pageNumber)
  );
  const questions: RevisionQuestion[] = [];
  const generatedPrompts: string[] = [];
  const usedSlotChunkIds = new Set<string>();

  for (let b = 0; b < batchCount; b += 1) {
    const slotChunksRaw = (slotPickedIds[b] || [])
      .map((id) => chunkMap.get(id))
      .filter((c): c is SampledChunk => Boolean(c));

    const pedagogicalSlot = slotChunksRaw
      .filter(
        (c) =>
          !usedSlotChunkIds.has(c.id) &&
          !isAdministrativeOrTocText(c.content, c.pageNumber) &&
          c.content.length >= 40
      )
      .sort(
        (a, b) =>
          scoreChunkPedagogicalQuality(b.content, b.pageNumber) -
          scoreChunkPedagogicalQuality(a.content, a.pageNumber)
      );

    const substantial =
      pedagogicalSlot.length >= 4
        ? pedagogicalSlot
        : slotChunksRaw
            .filter((c) => c.content.length >= 40 && !usedSlotChunkIds.has(c.id))
            .sort(
              (a, b) =>
                scoreChunkPedagogicalQuality(b.content, b.pageNumber) -
                scoreChunkPedagogicalQuality(a.content, a.pageNumber)
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

    let aiEnriched = options?.skipAi
      ? null
      : await tryOllamaQuizEnrichment(c1, c2, c3, c4, {
          chapterTitle: slotChapterTitle,
          freshnessSeed: options?.freshnessSeed,
          avoidPrompts: generatedPrompts,
        });

    // If AI responded but left invalid/missing slots, retry once with alternate extracts from the chapter
    if (
      aiEnriched &&
      (!aiEnriched.qcu ||
        !aiEnriched.qcm ||
        !aiEnriched.qroc ||
        !aiEnriched.flashcard)
    ) {
      const altPool =
        chapterPool.length > 4
          ? chapterPool.slice(4)
          : allPool.filter(
              (c) => !isAdministrativeOrTocText(c.content, c.pageNumber)
            );
      if (altPool.length > 0) {
        const alt4 = [
          altPool[0 % altPool.length],
          altPool[1 % altPool.length],
          altPool[2 % altPool.length],
          altPool[3 % altPool.length],
        ];
        const retryAvoid = [
          ...generatedPrompts,
          aiEnriched.qcu?.prompt,
          aiEnriched.qcm?.prompt,
          aiEnriched.qroc?.prompt,
          aiEnriched.flashcard?.prompt,
        ].filter((p): p is string => Boolean(p));

        const secondTry = await tryOllamaQuizEnrichment(
          alt4[0],
          alt4[1],
          alt4[2],
          alt4[3],
          {
            chapterTitle: slotChapterTitle,
            freshnessSeed: options?.freshnessSeed,
            avoidPrompts: retryAvoid,
          }
        );
        if (secondTry) {
          aiEnriched = {
            qcu: aiEnriched.qcu || secondTry.qcu,
            qcm: aiEnriched.qcm || secondTry.qcm,
            qroc: aiEnriched.qroc || secondTry.qroc,
            flashcard: aiEnriched.flashcard || secondTry.flashcard,
          };
        }
      }
    }

    const fallbackQcu = aiEnriched?.qcu ? null : buildFallbackQCU(c1, allPool);
    const fallbackQcm = aiEnriched?.qcm ? null : buildFallbackQCM(c2, allPool);
    const fallbackQroc = aiEnriched?.qroc ? null : buildFallbackQROC(c3);
    const fallbackFlashcard = aiEnriched?.flashcard
      ? null
      : buildFallbackFlashcard(c4);

    const makeBaseMeta = (src: SampledChunk) => ({
      id: `q-${crypto.randomUUID().slice(0, 8)}`,
      ueId: src.ueId,
      ueCode: src.ueCode,
      ueTitle: src.ueTitle,
      chapterId: src.chapterId,
      chapterTitle: src.chapterTitle,
      documentId: src.documentId,
      documentTitle: src.documentTitle,
      fileName: src.fileName,
      pageNumber: src.pageNumber,
    });

    const batchQuestions: RevisionQuestion[] = [
      aiEnriched?.qcu
        ? ({
            ...makeBaseMeta(c1),
            type: "QCU",
            prompt: aiEnriched.qcu.prompt!,
            options: aiEnriched.qcu.options!,
            correctIndices: aiEnriched.qcu.correctIndices!,
            explanation: aiEnriched.qcu.explanation || "",
            generatedByAi: true,
          } satisfies RevisionQuestion)
        : fallbackQcu!,
      aiEnriched?.qcm
        ? ({
            ...makeBaseMeta(c2),
            type: "QCM",
            prompt: aiEnriched.qcm.prompt!,
            options: aiEnriched.qcm.options!,
            correctIndices: aiEnriched.qcm.correctIndices!,
            explanation: aiEnriched.qcm.explanation || "",
            generatedByAi: true,
          } satisfies RevisionQuestion)
        : fallbackQcm!,
      aiEnriched?.qroc
        ? ({
            ...makeBaseMeta(c3),
            type: "QROC",
            prompt: aiEnriched.qroc.prompt!,
            correctAnswer: aiEnriched.qroc.correctAnswer!,
            acceptedKeywords: aiEnriched.qroc.acceptedKeywords!,
            explanation: aiEnriched.qroc.explanation || "",
            generatedByAi: true,
          } satisfies RevisionQuestion)
        : fallbackQroc!,
      aiEnriched?.flashcard
        ? ({
            ...makeBaseMeta(c4),
            type: "FLASHCARD",
            prompt: aiEnriched.flashcard.prompt!,
            flashcardBack: aiEnriched.flashcard.flashcardBack!,
            explanation: aiEnriched.flashcard.explanation || "",
            generatedByAi: true,
          } satisfies RevisionQuestion)
        : fallbackFlashcard!,
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
    const correct = isRevisionQuestionCorrect(q, answers[q.id]);
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
          ) ||
          hasGenericPlaceholderLeak(q.explanation) ||
          (q.type === "QROC" &&
            (!q.correctAnswer || !isValidQrocQuestion(q.prompt, q.correctAnswer)))
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
