import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { recordMissedQuestions } from "@/lib/error-book";
import {
  generateQuizQuestions,
  gradeRevisionAnswers,
  type RevisionAnswerValue,
  type RevisionQuestion,
} from "@/lib/revisions";

interface ChapterBreakdownItem {
  chapterTitle: string;
  correct: number;
  total: number;
  percent: number;
}

interface MockExamRow {
  id: string;
  userId: string;
  ueId: string;
  durationMinutes: number;
  questionsJson: string;
  answersJson: string;
  score: number;
  totalQuestions: number;
  grade20: number;
  chapterBreakdownJson: string;
  completed: boolean;
  startedAt: Date | string;
  completedAt: Date | string | null;
}

let mockExamSchemaEnsured = false;

/**
 * Ensures "MockExamSession" table exists with strictly 1 SQL command per $executeRawUnsafe call.
 */
async function ensureMockExamSchema(): Promise<void> {
  if (mockExamSchemaEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "MockExamSession" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "ueId" TEXT NOT NULL,
        "durationMinutes" INTEGER NOT NULL,
        "questionsJson" TEXT NOT NULL,
        "answersJson" TEXT NOT NULL DEFAULT '{}',
        "score" INTEGER NOT NULL DEFAULT 0,
        "totalQuestions" INTEGER NOT NULL DEFAULT 0,
        "grade20" DOUBLE PRECISION NOT NULL DEFAULT 0,
        "chapterBreakdownJson" TEXT NOT NULL DEFAULT '[]',
        "completed" BOOLEAN NOT NULL DEFAULT false,
        "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "completedAt" TIMESTAMP(3),
        CONSTRAINT "MockExamSession_pkey" PRIMARY KEY ("id")
      );
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "MockExamSession_userId_ueId_idx"
      ON "MockExamSession"("userId", "ueId");
    `);
    mockExamSchemaEnsured = true;
  } catch (err) {
    console.warn("[MockExams] Schema check warning:", err);
  }
}

async function fetchExamHistory(userId: string, ueId: string) {
  await ensureMockExamSchema();
  const rows = await prisma.$queryRaw<MockExamRow[]>`
    SELECT "id", "userId", "ueId", "durationMinutes", "questionsJson", "answersJson",
           "score", "totalQuestions", "grade20", "chapterBreakdownJson", "completed",
           "startedAt", "completedAt"
    FROM "MockExamSession"
    WHERE "userId" = ${userId} AND "ueId" = ${ueId} AND "completed" = true
    ORDER BY "completedAt" DESC
    LIMIT 15
  `;

  return rows.map((r) => {
    let chapterBreakdown: ChapterBreakdownItem[] = [];
    try {
      chapterBreakdown = JSON.parse(
        r.chapterBreakdownJson || "[]"
      ) as ChapterBreakdownItem[];
    } catch {
      chapterBreakdown = [];
    }
    return {
      id: r.id,
      durationMinutes: Number(r.durationMinutes),
      score: Number(r.score),
      totalQuestions: Number(r.totalQuestions),
      grade20: Number(r.grade20),
      chapterBreakdown,
      completedAt:
        r.completedAt instanceof Date
          ? r.completedAt.toISOString()
          : String(r.completedAt || r.startedAt),
    };
  });
}

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const ueId = searchParams.get("ueId")?.trim();
  if (!ueId) {
    return NextResponse.json({ error: "ueId requis" }, { status: 400 });
  }

  const history = await fetchExamHistory(user.id, ueId);
  return NextResponse.json({ history });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  await ensureMockExamSchema();

  try {
    const body = (await req.json()) as {
      action?: "START" | "SUBMIT";
      ueId?: string;
      count?: number;
      durationMinutes?: number;
      examId?: string;
      answers?: Record<string, RevisionAnswerValue>;
    };

    if (body.action === "START") {
      const ueId = body.ueId?.trim();
      if (!ueId) {
        return NextResponse.json({ error: "ueId requis" }, { status: 400 });
      }

      const count = Math.max(4, Math.min(20, Number(body.count || 8)));
      const durationMinutes = Math.max(
        5,
        Math.min(90, Number(body.durationMinutes || 20))
      );

      const questions = await generateQuizQuestions({
        userId: user.id,
        ueId,
        count,
      });

      if (questions.length === 0) {
        return NextResponse.json(
          {
            error:
              "Aucun document PDF indexé dans cette UE. Déposez au moins un PDF pour lancer un partiel blanc.",
          },
          { status: 400 }
        );
      }

      const examId = `exam-${crypto.randomUUID().slice(0, 12)}`;
      const questionsJson = JSON.stringify(questions);

      await prisma.$executeRaw`
        INSERT INTO "MockExamSession" (
          "id", "userId", "ueId", "durationMinutes", "questionsJson",
          "totalQuestions", "completed", "startedAt"
        )
        VALUES (
          ${examId}, ${user.id}, ${ueId}, ${durationMinutes}, ${questionsJson},
          ${questions.length}, false, CURRENT_TIMESTAMP
        )
      `;

      return NextResponse.json(
        {
          exam: {
            id: examId,
            ueId,
            durationMinutes,
            questions,
            totalQuestions: questions.length,
          },
        },
        { status: 201 }
      );
    }

    if (body.action === "SUBMIT") {
      const examId = body.examId?.trim();
      if (!examId) {
        return NextResponse.json({ error: "examId requis" }, { status: 400 });
      }

      const rows = await prisma.$queryRaw<MockExamRow[]>`
        SELECT "id", "userId", "ueId", "durationMinutes", "questionsJson", "answersJson",
               "score", "totalQuestions", "grade20", "chapterBreakdownJson", "completed",
               "startedAt", "completedAt"
        FROM "MockExamSession"
        WHERE "id" = ${examId} AND "userId" = ${user.id}
        LIMIT 1
      `;

      const row = rows[0];
      if (!row) {
        return NextResponse.json(
          { error: "Copie de partiel blanc introuvable." },
          { status: 404 }
        );
      }

      let questions: RevisionQuestion[] = [];
      try {
        questions = JSON.parse(row.questionsJson) as RevisionQuestion[];
      } catch {
        questions = [];
      }

      const answers = body.answers || {};
      const { score, results } = gradeRevisionAnswers(questions, answers);
      const totalQuestions = Math.max(1, questions.length);
      const grade20 = Number(((score / totalQuestions) * 20).toFixed(1));

      const chapterMap = new Map<
        string,
        { correct: number; total: number }
      >();
      for (const q of questions) {
        const key = q.chapterTitle || "Général";
        const cur = chapterMap.get(key) || { correct: 0, total: 0 };
        cur.total += 1;
        if (results[q.id]) cur.correct += 1;
        chapterMap.set(key, cur);
      }

      const chapterBreakdown: ChapterBreakdownItem[] = Array.from(
        chapterMap.entries()
      ).map(([chapterTitle, stats]) => ({
        chapterTitle,
        correct: stats.correct,
        total: stats.total,
        percent: Math.round((stats.correct / Math.max(1, stats.total)) * 100),
      }));

      const answersJson = JSON.stringify(answers);
      const breakdownJson = JSON.stringify(chapterBreakdown);

      await prisma.$executeRaw`
        UPDATE "MockExamSession"
        SET "answersJson" = ${answersJson},
            "score" = ${score},
            "grade20" = ${grade20},
            "chapterBreakdownJson" = ${breakdownJson},
            "completed" = true,
            "completedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${examId} AND "userId" = ${user.id}
      `;

      const missed = questions.filter((q) => !results[q.id]);
      if (missed.length > 0) {
        await recordMissedQuestions(user.id, missed);
      }

      const history = await fetchExamHistory(user.id, row.ueId);

      return NextResponse.json({
        result: {
          id: examId,
          score,
          totalQuestions: questions.length,
          grade20,
          results,
          chapterBreakdown,
          missedAddedCount: missed.length,
          questions,
          answers,
        },
        history,
      });
    }

    return NextResponse.json({ error: "Action inconnue." }, { status: 400 });
  } catch (error) {
    console.error("[MockExams POST] Error:", error);
    return NextResponse.json(
      { error: "Erreur lors de l'examen blanc." },
      { status: 500 }
    );
  }
}
