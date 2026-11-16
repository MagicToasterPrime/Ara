import fsp from "node:fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManageUE, getCurrentUser } from "@/lib/auth";
import { resolveDocumentFilePath } from "@/lib/storage";

export async function POST(
  req: Request,
  { params }: { params: { ueId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const allowed = await canManageUE(user.id, user.globalRole, params.ueId);
  if (!allowed) {
    return NextResponse.json(
      { error: "Réservé au Responsable d'UE ou d'Année" },
      { status: 403 }
    );
  }

  try {
    const body = (await req.json()) as { title?: string; order?: number };
    const title = body.title?.trim();
    if (!title) {
      return NextResponse.json(
        { error: "Le titre du chapitre est requis." },
        { status: 400 }
      );
    }

    const existingCount = await prisma.chapter.count({
      where: { ueId: params.ueId },
    });

    const chapter = await prisma.chapter.create({
      data: {
        ueId: params.ueId,
        title,
        order:
          body.order !== undefined ? Number(body.order) : existingCount + 1,
      },
    });

    return NextResponse.json({ chapter }, { status: 201 });
  } catch (error) {
    console.error("[Chapters POST] Error:", error);
    return NextResponse.json(
      { error: "Impossible de créer le chapitre." },
      { status: 500 }
    );
  }
}

export async function PATCH(
  req: Request,
  { params }: { params: { ueId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const allowed = await canManageUE(user.id, user.globalRole, params.ueId);
  if (!allowed) {
    return NextResponse.json({ error: "Accès refusé" }, { status: 403 });
  }

  try {
    const body = (await req.json()) as {
      chapterId?: string;
      title?: string;
      order?: number;
    };
    if (!body.chapterId) {
      return NextResponse.json(
        { error: "chapterId requis" },
        { status: 400 }
      );
    }

    const chapter = await prisma.chapter.update({
      where: { id: body.chapterId, ueId: params.ueId },
      data: {
        ...(body.title ? { title: body.title.trim() } : {}),
        ...(body.order !== undefined ? { order: Number(body.order) } : {}),
      },
    });

    return NextResponse.json({ chapter });
  } catch (error) {
    console.error("[Chapters PATCH] Error:", error);
    return NextResponse.json(
      { error: "Impossible de modifier le chapitre." },
      { status: 500 }
    );
  }
}

export async function DELETE(
  req: Request,
  { params }: { params: { ueId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const allowed = await canManageUE(user.id, user.globalRole, params.ueId);
  if (!allowed) {
    return NextResponse.json({ error: "Accès refusé" }, { status: 403 });
  }

  try {
    const { searchParams } = new URL(req.url);
    const chapterId = searchParams.get("chapterId");
    if (!chapterId) {
      return NextResponse.json(
        { error: "chapterId requis" },
        { status: 400 }
      );
    }

    const docs = await prisma.document.findMany({
      where: { chapterId, chapter: { ueId: params.ueId } },
      select: { localPath: true },
    });

    await prisma.chapter.delete({
      where: { id: chapterId, ueId: params.ueId },
    });

    for (const doc of docs) {
      try {
        await fsp.unlink(resolveDocumentFilePath(doc.localPath));
      } catch {
        // Ignore missing files
      }
    }

    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error("[Chapters DELETE] Error:", error);
    return NextResponse.json(
      { error: "Impossible de supprimer le chapitre." },
      { status: 500 }
    );
  }
}
