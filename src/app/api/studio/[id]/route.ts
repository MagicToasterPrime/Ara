import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { ensureStudioSchema } from "@/lib/studio";

export async function PATCH(
  req: Request,
  { params }: { params: { id: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  await ensureStudioSchema();

  const existing = await prisma.studyArtifact.findUnique({
    where: { id: params.id },
  });

  if (!existing) {
    return NextResponse.json(
      { error: "Production introuvable." },
      { status: 404 }
    );
  }

  if (existing.userId !== user.id && user.globalRole !== "YEAR_ADMIN") {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  const body = (await req.json()) as {
    isPublic?: boolean;
    title?: string;
  };

  const artifact = await prisma.studyArtifact.update({
    where: { id: params.id },
    data: {
      ...(body.isPublic !== undefined ? { isPublic: Boolean(body.isPublic) } : {}),
      ...(body.title?.trim() ? { title: body.title.trim() } : {}),
    },
    include: {
      user: { select: { id: true, name: true } },
      ue: { select: { id: true, code: true, title: true } },
    },
  });

  return NextResponse.json({ artifact });
}

export async function DELETE(
  _req: Request,
  { params }: { params: { id: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  await ensureStudioSchema();

  const existing = await prisma.studyArtifact.findUnique({
    where: { id: params.id },
  });

  if (!existing) {
    return NextResponse.json(
      { error: "Production introuvable." },
      { status: 404 }
    );
  }

  if (existing.userId !== user.id && user.globalRole !== "YEAR_ADMIN") {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  await prisma.studyArtifact.delete({ where: { id: params.id } });
  return NextResponse.json({ deleted: true });
}
