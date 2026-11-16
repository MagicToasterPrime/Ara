import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManageUE, getCurrentUser } from "@/lib/auth";
import { ensureCommunityQuizSchema } from "@/lib/quiz-schema";
import type { CustomQuizQuestion } from "@/lib/quiz-types";

export async function GET(
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
    include: {
      author: { select: { id: true, name: true, globalRole: true } },
      ue: { select: { id: true, code: true, title: true, accentColor: true } },
      upvotes: { select: { userId: true } },
    },
  });

  if (!quiz) {
    return NextResponse.json({ error: "Test introuvable." }, { status: 404 });
  }

  if (
    !quiz.isPublic &&
    quiz.authorId !== user.id &&
    user.globalRole !== "YEAR_ADMIN"
  ) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  let questions: CustomQuizQuestion[] = [];
  try {
    questions = JSON.parse(quiz.questionsJson) as CustomQuizQuestion[];
  } catch {
    questions = [];
  }

  return NextResponse.json({
    quiz: {
      id: quiz.id,
      authorId: quiz.authorId,
      ueId: quiz.ueId,
      title: quiz.title,
      description: quiz.description,
      isPublic: quiz.isPublic,
      isPinned: quiz.isPinned,
      attemptsCount: quiz.attemptsCount,
      createdAt: quiz.createdAt,
      author: quiz.author,
      ue: quiz.ue,
      questions,
      upvoteCount: quiz.upvotes.length,
      hasUpvoted: quiz.upvotes.some((u) => u.userId === user.id),
    },
  });
}

export async function PATCH(
  req: Request,
  { params }: { params: { quizId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  await ensureCommunityQuizSchema();

  const existing = await prisma.communityQuiz.findUnique({
    where: { id: params.quizId },
  });

  if (!existing) {
    return NextResponse.json({ error: "Test introuvable." }, { status: 404 });
  }

  const body = (await req.json()) as {
    action?: "RECORD_ATTEMPT";
    isPinned?: boolean;
    isPublic?: boolean;
    title?: string;
    description?: string;
    questions?: CustomQuizQuestion[];
  };

  if (body.action === "RECORD_ATTEMPT") {
    const updated = await prisma.communityQuiz.update({
      where: { id: existing.id },
      data: { attemptsCount: { increment: 1 } },
      select: { id: true, attemptsCount: true },
    });
    return NextResponse.json({ quiz: updated });
  }

  const isManager = existing.ueId
    ? await canManageUE(user.id, user.globalRole, existing.ueId)
    : user.globalRole === "YEAR_ADMIN";

  if (body.isPinned !== undefined && !isManager) {
    return NextResponse.json(
      { error: "Seul un responsable d'UE ou d'année peut épingler ce test." },
      { status: 403 }
    );
  }

  const isAuthorOrAdmin =
    existing.authorId === user.id || user.globalRole === "YEAR_ADMIN";

  if (
    (body.title !== undefined ||
      body.description !== undefined ||
      body.isPublic !== undefined ||
      body.questions !== undefined) &&
    !isAuthorOrAdmin
  ) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const updated = await prisma.communityQuiz.update({
    where: { id: existing.id },
    data: {
      ...(body.isPinned !== undefined ? { isPinned: Boolean(body.isPinned) } : {}),
      ...(body.isPublic !== undefined ? { isPublic: Boolean(body.isPublic) } : {}),
      ...(body.title?.trim() ? { title: body.title.trim() } : {}),
      ...(body.description !== undefined
        ? { description: body.description.trim() }
        : {}),
      ...(Array.isArray(body.questions)
        ? { questionsJson: JSON.stringify(body.questions) }
        : {}),
    },
  });

  return NextResponse.json({ quiz: updated });
}

export async function DELETE(
  _req: Request,
  { params }: { params: { quizId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  await ensureCommunityQuizSchema();

  const existing = await prisma.communityQuiz.findUnique({
    where: { id: params.quizId },
  });

  if (!existing) {
    return NextResponse.json({ error: "Test introuvable." }, { status: 404 });
  }

  const isManager = existing.ueId
    ? await canManageUE(user.id, user.globalRole, existing.ueId)
    : false;

  if (
    existing.authorId !== user.id &&
    user.globalRole !== "YEAR_ADMIN" &&
    !isManager
  ) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  await prisma.communityQuiz.delete({ where: { id: existing.id } });
  return NextResponse.json({ deleted: true });
}
