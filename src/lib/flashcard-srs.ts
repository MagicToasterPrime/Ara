import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import { buildFlashcardKey } from "@/lib/artifact-export";
import type { FlashcardsPayload } from "@/lib/studio";

export { buildFlashcardKey };

export type FlashcardSrsRating = "AGAIN" | "HARD" | "GOOD" | "EASY";

export interface FlashcardSrsState {
  id: string;
  userId: string;
  artifactId: string;
  cardKey: string;
  ueId: string;
  ueCode: string;
  documentId: string;
  rating: FlashcardSrsRating;
  repetitions: number;
  intervalDays: number;
  easeFactor: number;
  mastered: boolean;
  nextReviewDate: string;
  updatedAt: string;
}

export interface DueFlashcardEntry {
  artifactId: string;
  artifactTitle: string;
  cardKey: string;
  ueId: string;
  ueCode: string;
  documentId: string;
  fileName: string;
  pageNumber: number;
  tag: string;
  front: string;
  back: string;
  repetitions: number;
  intervalDays: number;
  nextReviewDate: string;
}

export interface UserFlashcardSrsSummary {
  dueTodayCount: number;
  totalTrackedCount: number;
  masteredCount: number;
  dueByUe: Record<string, number>;
  dueDeck: DueFlashcardEntry[];
}

export function localSrsDateKey(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDaysToKey(days: number, baseDate = new Date()): string {
  const d = new Date(baseDate.getTime());
  d.setDate(d.getDate() + days);
  return localSrsDateKey(d);
}

export function computeSm2NextState(
  prev: { repetitions: number; intervalDays: number; easeFactor: number } | null,
  rating: FlashcardSrsRating,
  baseDate = new Date()
): {
  repetitions: number;
  intervalDays: number;
  easeFactor: number;
  mastered: boolean;
  nextReviewDate: string;
} {
  const rep = prev?.repetitions ?? 0;
  const prevInterval = prev?.intervalDays ?? 0;
  const ef = prev?.easeFactor ?? 2.5;

  let repetitions = rep;
  let intervalDays = 0;
  let easeFactor = ef;
  let mastered = false;

  if (rating === "AGAIN") {
    repetitions = 0;
    intervalDays = 0;
    easeFactor = Math.max(1.3, Math.round((ef - 0.2) * 100) / 100);
    mastered = false;
  } else if (rating === "HARD") {
    repetitions = rep;
    intervalDays = Math.max(1, Math.round((prevInterval || 1) * 1.2));
    easeFactor = Math.max(1.3, Math.round((ef - 0.15) * 100) / 100);
    mastered = false;
  } else if (rating === "GOOD") {
    repetitions = rep + 1;
    intervalDays =
      rep === 0
        ? 1
        : rep === 1
        ? 3
        : Math.max(4, Math.round((prevInterval || 3) * ef));
    easeFactor = Math.round(ef * 100) / 100;
    mastered = intervalDays >= 6 || repetitions >= 2;
  } else {
    repetitions = rep + 1;
    intervalDays =
      rep === 0 ? 4 : Math.max(5, Math.round((prevInterval || 3) * ef * 1.3));
    easeFactor = Math.min(3.0, Math.round((ef + 0.15) * 100) / 100);
    mastered = true;
  }

  return {
    repetitions,
    intervalDays,
    easeFactor,
    mastered,
    nextReviewDate: addDaysToKey(intervalDays, baseDate),
  };
}

const globalForFlashcardSrs = globalThis as typeof globalThis & {
  __araFlashcardSrsSchemaEnsured?: boolean;
};

export async function ensureFlashcardSrsSchema(): Promise<void> {
  if (globalForFlashcardSrs.__araFlashcardSrsSchemaEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "FlashcardReview" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "artifactId" TEXT NOT NULL,
        "cardKey" TEXT NOT NULL,
        "ueId" TEXT NOT NULL DEFAULT '',
        "ueCode" TEXT NOT NULL DEFAULT '',
        "documentId" TEXT NOT NULL DEFAULT '',
        "rating" TEXT NOT NULL,
        "repetitions" INTEGER NOT NULL DEFAULT 0,
        "intervalDays" INTEGER NOT NULL DEFAULT 0,
        "easeFactor" DOUBLE PRECISION NOT NULL DEFAULT 2.5,
        "mastered" BOOLEAN NOT NULL DEFAULT false,
        "nextReviewDate" TEXT NOT NULL,
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "FlashcardReview_pkey" PRIMARY KEY ("id")
      );
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "FlashcardReview_userId_artifactId_cardKey_key"
      ON "FlashcardReview"("userId", "artifactId", "cardKey");
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "FlashcardReview_userId_nextReviewDate_idx"
      ON "FlashcardReview"("userId", "nextReviewDate");
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "FlashcardReview_userId_ueId_idx"
      ON "FlashcardReview"("userId", "ueId");
    `);
    globalForFlashcardSrs.__araFlashcardSrsSchemaEnsured = true;
  } catch (err) {
    console.warn("[FlashcardSRS] Schema warning:", err);
  }
}

export async function recordFlashcardReview(params: {
  userId: string;
  artifactId: string;
  cardKey?: string;
  front: string;
  ueId?: string;
  ueCode?: string;
  documentId?: string;
  rating: FlashcardSrsRating;
}): Promise<FlashcardSrsState> {
  await ensureFlashcardSrsSchema();

  const cardKey =
    (params.cardKey && params.cardKey.trim().slice(0, 120)) ||
    buildFlashcardKey(params.front);

  const existingRows = await prisma.$queryRaw<
    Array<{ repetitions: number; intervalDays: number; easeFactor: number }>
  >`
    SELECT "repetitions", "intervalDays", "easeFactor"
    FROM "FlashcardReview"
    WHERE "userId" = ${params.userId}
      AND "artifactId" = ${params.artifactId}
      AND "cardKey" = ${cardKey}
    LIMIT 1
  `;

  const prev = existingRows[0] ?? null;
  const next = computeSm2NextState(prev, params.rating);
  const id = `fcrs-${crypto.randomUUID().slice(0, 12)}`;
  const ueId = params.ueId?.trim() || "";
  const ueCode = params.ueCode?.trim() || "";
  const documentId = params.documentId?.trim() || "";

  await prisma.$executeRaw`
    INSERT INTO "FlashcardReview" (
      "id", "userId", "artifactId", "cardKey", "ueId", "ueCode", "documentId",
      "rating", "repetitions", "intervalDays", "easeFactor", "mastered",
      "nextReviewDate", "updatedAt"
    )
    VALUES (
      ${id}, ${params.userId}, ${params.artifactId}, ${cardKey},
      ${ueId}, ${ueCode}, ${documentId},
      ${params.rating}, ${next.repetitions}, ${next.intervalDays}, ${next.easeFactor},
      ${next.mastered}, ${next.nextReviewDate}, CURRENT_TIMESTAMP
    )
    ON CONFLICT ("userId", "artifactId", "cardKey")
    DO UPDATE SET
      "ueId" = CASE WHEN EXCLUDED."ueId" <> '' THEN EXCLUDED."ueId" ELSE "FlashcardReview"."ueId" END,
      "ueCode" = CASE WHEN EXCLUDED."ueCode" <> '' THEN EXCLUDED."ueCode" ELSE "FlashcardReview"."ueCode" END,
      "documentId" = CASE WHEN EXCLUDED."documentId" <> '' THEN EXCLUDED."documentId" ELSE "FlashcardReview"."documentId" END,
      "rating" = EXCLUDED."rating",
      "repetitions" = EXCLUDED."repetitions",
      "intervalDays" = EXCLUDED."intervalDays",
      "easeFactor" = EXCLUDED."easeFactor",
      "mastered" = EXCLUDED."mastered",
      "nextReviewDate" = EXCLUDED."nextReviewDate",
      "updatedAt" = CURRENT_TIMESTAMP
  `;

  return {
    id,
    userId: params.userId,
    artifactId: params.artifactId,
    cardKey,
    ueId,
    ueCode,
    documentId,
    rating: params.rating,
    ...next,
    updatedAt: new Date().toISOString(),
  };
}

export async function getArtifactFlashcardReviews(
  userId: string,
  artifactId: string
): Promise<Record<string, FlashcardSrsState>> {
  await ensureFlashcardSrsSchema();
  const rows = await prisma.$queryRaw<
    Array<{
      id: string;
      userId: string;
      artifactId: string;
      cardKey: string;
      ueId: string;
      ueCode: string;
      documentId: string;
      rating: FlashcardSrsRating;
      repetitions: number;
      intervalDays: number;
      easeFactor: number;
      mastered: boolean;
      nextReviewDate: string;
      updatedAt: Date | string;
    }>
  >`
    SELECT "id", "userId", "artifactId", "cardKey", "ueId", "ueCode", "documentId",
           "rating", "repetitions", "intervalDays", "easeFactor", "mastered",
           "nextReviewDate", "updatedAt"
    FROM "FlashcardReview"
    WHERE "userId" = ${userId} AND "artifactId" = ${artifactId}
  `;

  const result: Record<string, FlashcardSrsState> = {};
  for (const r of rows) {
    result[r.cardKey] = {
      ...r,
      repetitions: Number(r.repetitions || 0),
      intervalDays: Number(r.intervalDays || 0),
      easeFactor: Number(r.easeFactor || 2.5),
      mastered: Boolean(r.mastered),
      updatedAt:
        r.updatedAt instanceof Date
          ? r.updatedAt.toISOString()
          : String(r.updatedAt),
    };
  }
  return result;
}

export async function getUserGlobalFlashcardSrsSummary(
  userId: string
): Promise<UserFlashcardSrsSummary> {
  await ensureFlashcardSrsSchema();
  const todayKey = localSrsDateKey();

  const rows = await prisma.$queryRaw<
    Array<{
      artifactId: string;
      cardKey: string;
      ueId: string;
      ueCode: string;
      documentId: string;
      repetitions: number;
      intervalDays: number;
      mastered: boolean;
      nextReviewDate: string;
    }>
  >`
    SELECT "artifactId", "cardKey", "ueId", "ueCode", "documentId",
           "repetitions", "intervalDays", "mastered", "nextReviewDate"
    FROM "FlashcardReview"
    WHERE "userId" = ${userId}
    ORDER BY "nextReviewDate" ASC, "updatedAt" DESC
    LIMIT 400
  `;

  let dueTodayCount = 0;
  let masteredCount = 0;
  const dueByUe: Record<string, number> = {};
  const dueRows: typeof rows = [];

  for (const r of rows) {
    if (r.mastered) {
      masteredCount += 1;
      continue;
    }
    if (r.nextReviewDate <= todayKey) {
      dueTodayCount += 1;
      if (r.ueId) {
        dueByUe[r.ueId] = (dueByUe[r.ueId] || 0) + 1;
      }
      if (dueRows.length < 40) {
        dueRows.push(r);
      }
    }
  }

  const dueDeck: DueFlashcardEntry[] = [];
  if (dueRows.length > 0) {
    const artifactIds = Array.from(new Set(dueRows.map((r) => r.artifactId)));
    const artifacts = await prisma.studyArtifact.findMany({
      where: { id: { in: artifactIds } },
      select: {
        id: true,
        title: true,
        ueId: true,
        contentJson: true,
        ue: { select: { code: true } },
      },
    });
    const artMap = new Map(artifacts.map((a) => [a.id, a]));

    for (const row of dueRows) {
      const art = artMap.get(row.artifactId);
      if (!art) continue;
      try {
        const parsed = JSON.parse(art.contentJson) as Partial<FlashcardsPayload>;
        const cards = Array.isArray(parsed.cards) ? parsed.cards : [];
        const match = cards.find(
          (c) => c.front && buildFlashcardKey(c.front) === row.cardKey
        );
        if (!match) continue;
        dueDeck.push({
          artifactId: art.id,
          artifactTitle: art.title,
          cardKey: row.cardKey,
          ueId: row.ueId || art.ueId || match.ueId || "",
          ueCode: row.ueCode || art.ue?.code || "",
          documentId: row.documentId || match.documentId || "",
          fileName: match.fileName || "cours.pdf",
          pageNumber: match.pageNumber || 1,
          tag: match.tag || "NOTION",
          front: match.front,
          back: match.back,
          repetitions: Number(row.repetitions || 0),
          intervalDays: Number(row.intervalDays || 0),
          nextReviewDate: row.nextReviewDate,
        });
      } catch {
        // Ignore corrupted artifact JSON
      }
    }
  }

  return {
    dueTodayCount,
    totalTrackedCount: rows.length,
    masteredCount,
    dueByUe,
    dueDeck,
  };
}
