import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";

export async function GET(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const whiteboard = await prisma.whiteboard.findUnique({
    where: { id: params.id },
    include: {
      ue: {
        select: {
          id: true,
          code: true,
          title: true,
          accentColor: true,
        },
      },
      creator: {
        select: {
          id: true,
          name: true,
        },
      },
    },
  });

  if (!whiteboard) {
    return NextResponse.json(
      { error: "Tableau blanc introuvable." },
      { status: 404 }
    );
  }

  return NextResponse.json({ whiteboard });
}

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  try {
    const body = (await req.json()) as {
      title?: string;
      snapshotData?: string;
    };

    const existing = await prisma.whiteboard.findUnique({
      where: { id: params.id },
      select: { id: true },
    });

    if (!existing) {
      return NextResponse.json(
        { error: "Tableau blanc introuvable." },
        { status: 404 }
      );
    }

    const updated = await prisma.whiteboard.update({
      where: { id: params.id },
      data: {
        ...(body.title?.trim() ? { title: body.title.trim() } : {}),
        ...(typeof body.snapshotData === "string"
          ? { snapshotData: body.snapshotData }
          : {}),
      },
      select: {
        id: true,
        title: true,
        updatedAt: true,
      },
    });

    return NextResponse.json({ whiteboard: updated });
  } catch (error) {
    console.error("[Whiteboard PATCH] Error:", error);
    return NextResponse.json(
      { error: "Impossible de sauvegarder le tableau blanc." },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const existing = await prisma.whiteboard.findUnique({
    where: { id: params.id },
    select: { id: true, creatorId: true },
  });

  if (!existing) {
    return NextResponse.json(
      { error: "Tableau blanc introuvable." },
      { status: 404 }
    );
  }

  if (
    existing.creatorId !== user.id &&
    user.globalRole !== "YEAR_ADMIN"
  ) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  await prisma.whiteboard.delete({ where: { id: params.id } });
  return NextResponse.json({ deleted: true });
}
