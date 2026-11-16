import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { ensureCommunityQuizSchema } from "@/lib/quiz-schema";
import type { CustomQuizQuestion } from "@/lib/quiz-types";

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  await ensureCommunityQuizSchema();

  const { searchParams } = new URL(req.url);
  const ueId = searchParams.get("ueId");

  const quizzes = await prisma.communityQuiz.findMany({
    where: {
      ...(ueId ? { ueId } : {}),
      OR: [{ isPublic: true }, { authorId: user.id }],
    },
    include: {
      author: {
        select: { id: true, name: true, globalRole: true },
      },
      ue: {
        select: { id: true, code: true, title: true, accentColor: true },
      },
      upvotes: {
        select: { userId: true },
      },
    },
    orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }],
  });

  const payload = quizzes
    .map((q) => {
      let questionCount = 0;
      let hasOcclusion = false;
      try {
        const parsed = JSON.parse(q.questionsJson) as CustomQuizQuestion[];
        if (Array.isArray(parsed)) {
          questionCount = parsed.length;
          hasOcclusion = parsed.some((item) => item.type === "IMAGE_OCCLUSION");
        }
      } catch {
        // Ignore parse error
      }

      return {
        id: q.id,
        authorId: q.authorId,
        ueId: q.ueId,
        title: q.title,
        description: q.description,
        isPublic: q.isPublic,
        isPinned: q.isPinned,
        attemptsCount: q.attemptsCount,
        createdAt: q.createdAt,
        updatedAt: q.updatedAt,
        author: q.author,
        ue: q.ue,
        questionCount,
        hasOcclusion,
        upvoteCount: q.upvotes.length,
        hasUpvoted: q.upvotes.some((u) => u.userId === user.id),
      };
    })
    .sort((a, b) => {
      if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
      if (b.upvoteCount !== a.upvoteCount) return b.upvoteCount - a.upvoteCount;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  return NextResponse.json({ quizzes: payload });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  await ensureCommunityQuizSchema();

  try {
    const body = (await req.json()) as {
      title?: string;
      description?: string;
      ueId?: string | null;
      isPublic?: boolean;
      questions?: CustomQuizQuestion[];
    };

    const title = body.title?.trim() || "";
    const description = body.description?.trim() || "";
    const ueId = body.ueId?.trim() || null;
    const isPublic = body.isPublic !== undefined ? Boolean(body.isPublic) : true;
    const questions = Array.isArray(body.questions) ? body.questions : [];

    if (!title) {
      return NextResponse.json(
        { error: "Le titre du test est requis." },
        { status: 400 }
      );
    }

    if (questions.length === 0) {
      return NextResponse.json(
        { error: "Ajoutez au moins une question à votre test." },
        { status: 400 }
      );
    }

    const quiz = await prisma.communityQuiz.create({
      data: {
        authorId: user.id,
        ueId,
        title,
        description,
        isPublic,
        questionsJson: JSON.stringify(questions),
      },
      include: {
        author: { select: { id: true, name: true, globalRole: true } },
        ue: { select: { id: true, code: true, title: true, accentColor: true } },
      },
    });

    return NextResponse.json(
      {
        quiz: {
          ...quiz,
          questionCount: questions.length,
          upvoteCount: 0,
          hasUpvoted: false,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[CommunityQuizzes POST] Error:", error);
    return NextResponse.json(
      { error: "Erreur lors de la création du test." },
      { status: 500 }
    );
  }
}
