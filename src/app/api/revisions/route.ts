import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import {
  getUserErrorBook,
  recordMissedQuestions,
  reviewErrorBookItem,
  type SrsRating,
} from "@/lib/error-book";
import {
  computeEffectiveStreak,
  ensureRevisionSchema,
  generateQuizQuestions,
  getLocalDateKey,
  getOrGenerateSharedDailyQuiz,
  getYesterdayDateKey,
  gradeRevisionAnswers,
  type RevisionAnswerValue,
  type RevisionQuestion,
  type SharedDailyQuizRecord,
} from "@/lib/revisions";

function parseJsonSafe<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

async function buildPayload(
  userId: string,
  sharedQuizArg?: SharedDailyQuizRecord | null
) {
  const todayKey = getLocalDateKey();

  const [dbUser, todaySession, chunkCount, allParticipants, errorBook, sharedQuiz] =
    await Promise.all([
      prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          revisionEnabled: true,
          currentStreak: true,
          bestStreak: true,
          lastRevisionDate: true,
          totalRevisionPoints: true,
        },
      }),
      prisma.dailyRevisionSession.findUnique({
        where: {
          userId_dateKey: {
            userId,
            dateKey: todayKey,
          },
        },
      }),
      prisma.documentChunk.count(),
      prisma.user.findMany({
        where: {
          OR: [
            { revisionEnabled: true },
            { bestStreak: { gt: 0 } },
            { totalRevisionPoints: { gt: 0 } },
          ],
        },
        select: {
          id: true,
          name: true,
          currentStreak: true,
          bestStreak: true,
          lastRevisionDate: true,
          totalRevisionPoints: true,
        },
      }),
      getUserErrorBook(userId),
      sharedQuizArg !== undefined
        ? Promise.resolve(sharedQuizArg)
        : getOrGenerateSharedDailyQuiz(),
    ]);

  const effectiveStreak = dbUser
    ? computeEffectiveStreak(dbUser.currentStreak, dbUser.lastRevisionDate)
    : 0;

  const leaderboard = allParticipants
    .map((u) => ({
      id: u.id,
      name: u.name,
      currentStreak: computeEffectiveStreak(
        u.currentStreak,
        u.lastRevisionDate
      ),
      bestStreak: u.bestStreak,
      totalRevisionPoints: u.totalRevisionPoints,
      completedToday: u.lastRevisionDate === todayKey,
    }))
    .sort((a, b) => {
      if (b.currentStreak !== a.currentStreak) {
        return b.currentStreak - a.currentStreak;
      }
      if (b.bestStreak !== a.bestStreak) {
        return b.bestStreak - a.bestStreak;
      }
      return b.totalRevisionPoints - a.totalRevisionPoints;
    })
    .slice(0, 30);

  const parsedQuestions = todaySession
    ? parseJsonSafe<RevisionQuestion[]>(todaySession.questionsJson, [])
    : [];
  const parsedAnswers = todaySession
    ? parseJsonSafe<Record<string, RevisionAnswerValue>>(
        todaySession.answersJson,
        {}
      )
    : {};

  return {
    userState: {
      revisionEnabled: dbUser?.revisionEnabled ?? false,
      currentStreak: effectiveStreak,
      bestStreak: dbUser?.bestStreak ?? 0,
      lastRevisionDate: dbUser?.lastRevisionDate ?? null,
      totalRevisionPoints: dbUser?.totalRevisionPoints ?? 0,
      completedToday: dbUser?.lastRevisionDate === todayKey,
    },
    todayKey,
    hasCourseContent: chunkCount > 0,
    todaySession: todaySession
      ? {
          id: todaySession.id,
          dateKey: todaySession.dateKey,
          questions: parsedQuestions,
          answers: parsedAnswers,
          score: todaySession.score,
          totalQuestions: todaySession.totalQuestions,
          completed: todaySession.completed,
          completedAt: todaySession.completedAt,
        }
      : null,
    leaderboard,
    errorBook,
    sharedQuizMeta: sharedQuiz
      ? {
          dateKey: sharedQuiz.dateKey,
          ueCode: sharedQuiz.ueCode,
          ueTitle: sharedQuiz.ueTitle,
          generatedAt: sharedQuiz.generatedAt,
          generatedByAi: sharedQuiz.generatedByAi,
        }
      : null,
  };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  await ensureRevisionSchema();

  const [dbUser, sharedQuiz] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: { revisionEnabled: true, lastRevisionDate: true },
    }),
    getOrGenerateSharedDailyQuiz(),
  ]);

  const todayKey = getLocalDateKey();
  if (dbUser?.revisionEnabled && sharedQuiz && sharedQuiz.questions.length > 0) {
    const existing = await prisma.dailyRevisionSession.findUnique({
      where: { userId_dateKey: { userId: user.id, dateKey: todayKey } },
    });
    const sharedQuestionsJson = JSON.stringify(sharedQuiz.questions);

    if (!existing) {
      await prisma.dailyRevisionSession
        .upsert({
          where: { userId_dateKey: { userId: user.id, dateKey: todayKey } },
          update: {},
          create: {
            userId: user.id,
            dateKey: todayKey,
            questionsJson: sharedQuestionsJson,
            totalQuestions: sharedQuiz.questions.length,
          },
        })
        .catch(() => null);
    } else if (
      !existing.completed &&
      existing.answersJson === "{}" &&
      dbUser.lastRevisionDate !== todayKey &&
      existing.questionsJson !== sharedQuestionsJson
    ) {
      await prisma.dailyRevisionSession
        .update({
          where: { id: existing.id },
          data: {
            questionsJson: sharedQuestionsJson,
            totalQuestions: sharedQuiz.questions.length,
          },
        })
        .catch(() => null);
    }
  }

  const payload = await buildPayload(user.id, sharedQuiz);
  return NextResponse.json(payload);
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  await ensureRevisionSchema();

  try {
    const body = (await req.json()) as {
      action?:
        | "TOGGLE"
        | "GENERATE_DAILY"
        | "GENERATE_BONUS"
        | "SUBMIT"
        | "REVIEW_ERROR";
      enabled?: boolean;
      forceShared?: boolean;
      sessionId?: string;
      answers?: Record<string, RevisionAnswerValue>;
      errorItemId?: string;
      rating?: SrsRating;
    };

    const todayKey = getLocalDateKey();
    const yesterdayKey = getYesterdayDateKey();

    if (body.action === "REVIEW_ERROR") {
      const errorItemId = body.errorItemId?.trim();
      const rating = body.rating;
      if (
        !errorItemId ||
        (rating !== "AGAIN" &&
          rating !== "HARD" &&
          rating !== "GOOD" &&
          rating !== "EASY")
      ) {
        return NextResponse.json(
          { error: "Paramètres de révision SRS invalides." },
          { status: 400 }
        );
      }
      await reviewErrorBookItem(user.id, errorItemId, rating);
      const payload = await buildPayload(user.id);
      return NextResponse.json(payload);
    }

    if (body.action === "TOGGLE") {
      const enabled = Boolean(body.enabled);
      await prisma.user.update({
        where: { id: user.id },
        data: { revisionEnabled: enabled },
      });

      if (enabled) {
        const existing = await prisma.dailyRevisionSession.findUnique({
          where: { userId_dateKey: { userId: user.id, dateKey: todayKey } },
        });
        if (!existing) {
          const shared = await getOrGenerateSharedDailyQuiz();
          const questions = shared?.questions || [];
          if (questions.length > 0) {
            await prisma.dailyRevisionSession
              .upsert({
                where: {
                  userId_dateKey: { userId: user.id, dateKey: todayKey },
                },
                update: {},
                create: {
                  userId: user.id,
                  dateKey: todayKey,
                  questionsJson: JSON.stringify(questions),
                  totalQuestions: questions.length,
                },
              })
              .catch(() => null);
          }
        }
      }

      const payload = await buildPayload(user.id);
      return NextResponse.json(payload);
    }

    if (
      body.action === "GENERATE_DAILY" ||
      body.action === "GENERATE_BONUS"
    ) {
      let sharedQuizResult: SharedDailyQuizRecord | null | undefined = undefined;
      let questions: RevisionQuestion[] = [];

      if (body.action === "GENERATE_DAILY") {
        const forceRegenerate =
          user.globalRole === "YEAR_ADMIN" && Boolean(body.forceShared);
        sharedQuizResult = await getOrGenerateSharedDailyQuiz({
          forceRegenerate,
        });
        questions = sharedQuizResult?.questions || [];
      } else {
        questions = await generateQuizQuestions({ userId: user.id, count: 8 });
      }

      if (questions.length === 0) {
        return NextResponse.json(
          {
            error:
              "Aucun cours PDF n'est encore disponible pour générer un quiz. Déposez un PDF dans une UE d'abord.",
          },
          { status: 400 }
        );
      }

      const existing = await prisma.dailyRevisionSession.findUnique({
        where: { userId_dateKey: { userId: user.id, dateKey: todayKey } },
      });

      if (!existing) {
        await prisma.dailyRevisionSession
          .upsert({
            where: { userId_dateKey: { userId: user.id, dateKey: todayKey } },
            update: {},
            create: {
              userId: user.id,
              dateKey: todayKey,
              questionsJson: JSON.stringify(questions),
              totalQuestions: questions.length,
            },
          })
          .catch(() => null);
      } else if (body.action === "GENERATE_BONUS" || !existing.completed) {
        await prisma.dailyRevisionSession.update({
          where: { id: existing.id },
          data: {
            questionsJson: JSON.stringify(questions),
            answersJson: "{}",
            score: 0,
            totalQuestions: questions.length,
            completed: false,
            completedAt: null,
          },
        });
      }

      const payload = await buildPayload(user.id, sharedQuizResult);
      return NextResponse.json(payload);
    }

    if (body.action === "SUBMIT") {
      const session = await prisma.dailyRevisionSession.findUnique({
        where: { userId_dateKey: { userId: user.id, dateKey: todayKey } },
      });

      if (!session) {
        return NextResponse.json(
          { error: "Aucune séance de révision trouvée pour aujourd'hui." },
          { status: 404 }
        );
      }

      const questions = parseJsonSafe<RevisionQuestion[]>(
        session.questionsJson,
        []
      );
      const submittedAnswers = body.answers || {};
      const { score, results } = gradeRevisionAnswers(
        questions,
        submittedAnswers
      );

      await prisma.$transaction(async (tx) => {
        await tx.dailyRevisionSession.update({
          where: { id: session.id },
          data: {
            answersJson: JSON.stringify(submittedAnswers),
            score,
            totalQuestions: questions.length,
            completed: true,
            completedAt: new Date(),
          },
        });

        const currentUser = await tx.user.findUnique({
          where: { id: user.id },
          select: {
            currentStreak: true,
            bestStreak: true,
            lastRevisionDate: true,
            totalRevisionPoints: true,
          },
        });

        if (currentUser) {
          const alreadyCompletedToday =
            currentUser.lastRevisionDate === todayKey;
          let nextStreak = computeEffectiveStreak(
            currentUser.currentStreak,
            currentUser.lastRevisionDate
          );

          if (!alreadyCompletedToday) {
            nextStreak =
              currentUser.lastRevisionDate === yesterdayKey
                ? currentUser.currentStreak + 1
                : 1;
          }

          const nextBest = Math.max(currentUser.bestStreak, nextStreak);
          const earnedPoints = alreadyCompletedToday
            ? Math.max(10, score * 10)
            : 25 + score * 25;

          await tx.user.update({
            where: { id: user.id },
            data: {
              revisionEnabled: true,
              currentStreak: nextStreak,
              bestStreak: nextBest,
              lastRevisionDate: todayKey,
              totalRevisionPoints:
                currentUser.totalRevisionPoints + earnedPoints,
            },
          });
        }
      });

      const missedQuestions = questions.filter((q) => !results[q.id]);
      if (missedQuestions.length > 0) {
        await recordMissedQuestions(user.id, missedQuestions);
      }

      const payload = await buildPayload(user.id);
      return NextResponse.json({
        ...payload,
        gradingResults: results,
      });
    }

    return NextResponse.json({ error: "Action non reconnue." }, { status: 400 });
  } catch (error) {
    console.error("[Revisions POST] Error:", error);
    return NextResponse.json(
      { error: "Erreur lors de la séance de révision." },
      { status: 500 }
    );
  }
}
