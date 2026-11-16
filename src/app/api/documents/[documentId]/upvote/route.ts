import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

export async function POST(
  _req: Request,
  { params }: { params: { documentId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const doc = await prisma.document.findUnique({
    where: { id: params.documentId },
    select: { id: true },
  });

  if (!doc) {
    return NextResponse.json(
      { error: "Document introuvable." },
      { status: 404 }
    );
  }

  const existing = await prisma.documentUpvote.findUnique({
    where: {
      userId_documentId: {
        userId: user.id,
        documentId: doc.id,
      },
    },
  });

  let upvoted: boolean;
  if (existing) {
    await prisma.documentUpvote.delete({
      where: {
        userId_documentId: {
          userId: user.id,
          documentId: doc.id,
        },
      },
    });
    upvoted = false;
  } else {
    await prisma.documentUpvote.create({
      data: {
        userId: user.id,
        documentId: doc.id,
      },
    });
    upvoted = true;
  }

  const count = await prisma.documentUpvote.count({
    where: { documentId: doc.id },
  });

  return NextResponse.json({ upvoted, count });
}
