import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { ensureCommunityQuizSchema } from "@/lib/quiz-schema";

export async function POST(
  _req: Request,
  { params }: { params: { quizId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  await ensureCommunityQuizSchema();

  const quiz = await prisma.communityQuiz.findUnique({
    where: { id: params.quizId },
    select: { id: true },
  });

  if (!quiz) {
    return NextResponse.json({ error: "Test introuvable." }, { status: 404 });
  }

  const existing = await prisma.communityQuizUpvote.findUnique({
    where: {
      userId_quizId: {
        userId: user.id,
        quizId: quiz.id,
      },
    },
  });

  let upvoted: boolean;
  if (existing) {
    await prisma.communityQuizUpvote.delete({
      where: {
        userId_quizId: {
          userId: user.id,
          quizId: quiz.id,
        },
      },
    });
    upvoted = false;
  } else {
    await prisma.communityQuizUpvote.create({
      data: {
        userId: user.id,
        quizId: quiz.id,
      },
    });
    upvoted = true;
  }

  const count = await prisma.communityQuizUpvote.count({
    where: { quizId: quiz.id },
  });

  return NextResponse.json({ upvoted, count });
}
