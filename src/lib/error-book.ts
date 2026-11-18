import { prisma } from "@/lib/prisma";
import type { RevisionQuestion } from "@/lib/revisions";

function localDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export type SrsRating = "AGAIN" | "HARD" | "GOOD" | "EASY";

export interface ErrorBookCard {
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

export interface WeakChapterSummary {
  ueId: string;
  ueCode: string;
  chapterTitle: string;
  errorCount: number;
  activeItems: number;
}

export interface UserErrorBookPayload {
  items: ErrorBookCard[];
  weakChapters: WeakChapterSummary[];
  dueCount: number;
  activeCount: number;
  masteredCount: number;
}

let errorBookSchemaEnsured = false;

/**
 * Ensures "ErrorBookItem" exists with strictly 1 SQL command per $executeRawUnsafe call.
 */
export async function ensureErrorBookSchema(): Promise<void> {
  if (errorBookSchemaEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ErrorBookItem" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "fingerprint" TEXT NOT NULL,
        "ueId" TEXT NOT NULL,
        "ueCode" TEXT NOT NULL,
        "chapterId" TEXT NOT NULL DEFAULT '',
        "chapterTitle" TEXT NOT NULL,
        "questionJson" TEXT NOT NULL,
        "wrongCount" INTEGER NOT NULL DEFAULT 1,
        "srsBox" INTEGER NOT NULL DEFAULT 1,
        "mastered" BOOLEAN NOT NULL DEFAULT false,
        "nextReviewDate" TEXT NOT NULL,
        "lastMissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "ErrorBookItem_pkey" PRIMARY KEY ("id")
      );
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ErrorBookItem_userId_fingerprint_key"
      ON "ErrorBookItem"("userId", "fingerprint");
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "ErrorBookItem_userId_mastered_idx"
      ON "ErrorBookItem"("userId", "mastered");
    `);
    errorBookSchemaEnsured = true;
  } catch (err) {
    console.warn("[ErrorBook] Schema check warning:", err);
  }
}

function addDaysKey(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return localDateKey(d);
}

function buildFingerprint(q: RevisionQuestion): string {
  return `${q.documentId}:${q.pageNumber}:${q.type}:${q.prompt
    .trim()
    .slice(0, 72)
    .toLowerCase()}`;
}

export async function recordMissedQuestions(
  userId: string,
  questions: RevisionQuestion[]
): Promise<void> {
  if (questions.length === 0) return;
  await ensureErrorBookSchema();
  const todayKey = localDateKey();

  for (const q of questions) {
    const id = `err-${crypto.randomUUID().slice(0, 12)}`;
    const fingerprint = buildFingerprint(q);
    const questionJson = JSON.stringify(q);
    const chapterId = q.chapterId || "";

    await prisma.$executeRaw`
      INSERT INTO "ErrorBookItem" (
        "id", "userId", "fingerprint", "ueId", "ueCode",
        "chapterId", "chapterTitle", "questionJson",
        "wrongCount", "srsBox", "mastered", "nextReviewDate", "lastMissedAt"
      )
      VALUES (
        ${id}, ${userId}, ${fingerprint}, ${q.ueId}, ${q.ueCode},
        ${chapterId}, ${q.chapterTitle}, ${questionJson},
        1, 1, false, ${todayKey}, CURRENT_TIMESTAMP
      )
      ON CONFLICT ("userId", "fingerprint")
      DO UPDATE SET
        "wrongCount" = "ErrorBookItem"."wrongCount" + 1,
        "srsBox" = 1,
        "mastered" = false,
        "nextReviewDate" = EXCLUDED."nextReviewDate",
        "questionJson" = EXCLUDED."questionJson",
        "lastMissedAt" = CURRENT_TIMESTAMP
    `;
  }
}

interface RawErrorRow {
  id: string;
  fingerprint: string;
  ueId: string;
  ueCode: string;
  chapterId: string;
  chapterTitle: string;
  questionJson: string;
  wrongCount: number;
  srsBox: number;
  mastered: boolean;
  nextReviewDate: string;
}

export async function reviewErrorBookItem(
  userId: string,
  itemId: string,
  rating: SrsRating
): Promise<void> {
  await ensureErrorBookSchema();
  const rows = await prisma.$queryRaw<Array<{ srsBox: number }>>`
    SELECT "srsBox"
    FROM "ErrorBookItem"
    WHERE "id" = ${itemId} AND "userId" = ${userId}
    LIMIT 1
  `;

  if (rows.length === 0) return;
  const currentBox = Number(rows[0].srsBox || 1);

  let nextBox = 1;
  let daysDelay = 0;
  let mastered = false;

  if (rating === "AGAIN") {
    nextBox = 1;
    daysDelay = 0;
    mastered = false;
  } else if (rating === "HARD") {
    nextBox = Math.max(1, currentBox);
    daysDelay = 1;
    mastered = false;
  } else if (rating === "GOOD") {
    nextBox = Math.min(5, currentBox + 1);
    daysDelay = currentBox >= 2 ? 3 : 2;
    mastered = nextBox >= 4;
  } else {
    nextBox = 5;
    daysDelay = 7;
    mastered = true;
  }

  const nextReviewDate = addDaysKey(daysDelay);

  await prisma.$executeRaw`
    UPDATE "ErrorBookItem"
    SET "srsBox" = ${nextBox},
        "mastered" = ${mastered},
        "nextReviewDate" = ${nextReviewDate}
    WHERE "id" = ${itemId} AND "userId" = ${userId}
  `;
}

export async function getUserErrorBook(
  userId: string
): Promise<UserErrorBookPayload> {
  await ensureErrorBookSchema();
  const todayKey = localDateKey();

  const rows = await prisma.$queryRaw<RawErrorRow[]>`
    SELECT "id", "fingerprint", "ueId", "ueCode", "chapterId", "chapterTitle",
           "questionJson", "wrongCount", "srsBox", "mastered", "nextReviewDate"
    FROM "ErrorBookItem"
    WHERE "userId" = ${userId}
    ORDER BY "mastered" ASC, "wrongCount" DESC, "lastMissedAt" DESC
    LIMIT 60
  `;

  const items: ErrorBookCard[] = [];
  const chapterAgg = new Map<string, WeakChapterSummary>();
  let dueCount = 0;
  let activeCount = 0;
  let masteredCount = 0;

  for (const row of rows) {
    let parsedQuestion: RevisionQuestion | null = null;
    try {
      parsedQuestion = JSON.parse(row.questionJson) as RevisionQuestion;
    } catch {
      parsedQuestion = null;
    }
    if (!parsedQuestion) continue;

    const mastered = Boolean(row.mastered);
    if (mastered) {
      masteredCount += 1;
    } else {
      activeCount += 1;
      if (row.nextReviewDate <= todayKey) {
        dueCount += 1;
      }
    }

    const key = `${row.ueCode}::${row.chapterTitle}`;
    const prev = chapterAgg.get(key) || {
      ueId: row.ueId,
      ueCode: row.ueCode,
      chapterTitle: row.chapterTitle,
      errorCount: 0,
      activeItems: 0,
    };
    prev.errorCount += Number(row.wrongCount || 1);
    if (!mastered) prev.activeItems += 1;
    chapterAgg.set(key, prev);

    items.push({
      id: row.id,
      fingerprint: row.fingerprint,
      ueId: row.ueId,
      ueCode: row.ueCode,
      chapterId: row.chapterId || "",
      chapterTitle: row.chapterTitle,
      wrongCount: Number(row.wrongCount || 1),
      srsBox: Number(row.srsBox || 1),
      mastered,
      nextReviewDate: row.nextReviewDate,
      question: parsedQuestion,
    });
  }

  const weakChapters = Array.from(chapterAgg.values())
    .sort((a, b) => b.activeItems - a.activeItems || b.errorCount - a.errorCount)
    .slice(0, 6);

  return {
    items,
    weakChapters,
    dueCount,
    activeCount,
    masteredCount,
  };
}
