import fsp from "node:fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManageUE, getCurrentUser } from "@/lib/auth";
import { resolveDocumentFilePath } from "@/lib/storage";

export async function GET(
  _req: Request,
  { params }: { params: { documentId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const doc = await prisma.document.findUnique({
    where: { id: params.documentId },
    select: {
      id: true,
      title: true,
      fileName: true,
      mimeType: true,
      fileSize: true,
      category: true,
      isPinned: true,
      isIndexed: true,
      pageCount: true,
      createdAt: true,
      chapter: {
        select: {
          id: true,
          title: true,
          ue: {
            select: {
              id: true,
              code: true,
              title: true,
            },
          },
        },
      },
      chunks: {
        orderBy: { pageNumber: "asc" },
        select: {
          id: true,
          pageNumber: true,
          content: true,
        },
      },
    },
  });

  if (!doc) {
    return NextResponse.json(
      { error: "Document introuvable." },
      { status: 404 }
    );
  }

  return NextResponse.json({ document: doc });
}

export async function PATCH(
  req: Request,
  { params }: { params: { documentId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const doc = await prisma.document.findUnique({
    where: { id: params.documentId },
    include: {
      chapter: { select: { ueId: true } },
    },
  });

  if (!doc) {
    return NextResponse.json(
      { error: "Document introuvable." },
      { status: 404 }
    );
  }

  const isManager = await canManageUE(
    user.id,
    user.globalRole,
    doc.chapter.ueId
  );
  if (!isManager && doc.authorId !== user.id) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  try {
    const body = (await req.json()) as {
      isPinned?: boolean;
      title?: string;
    };

    if (body.isPinned !== undefined && !isManager) {
      return NextResponse.json(
        {
          error:
            "Seul un responsable d'UE ou d'année peut épingler/valider un document.",
        },
        { status: 403 }
      );
    }

    const updated = await prisma.document.update({
      where: { id: doc.id },
      data: {
        ...(body.isPinned !== undefined ? { isPinned: Boolean(body.isPinned) } : {}),
        ...(body.title?.trim() ? { title: body.title.trim() } : {}),
      },
    });

    return NextResponse.json({ document: updated });
  } catch (error) {
    console.error("[Document PATCH] Error:", error);
    return NextResponse.json(
      { error: "Impossible de mettre à jour le document." },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: { documentId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const doc = await prisma.document.findUnique({
    where: { id: params.documentId },
    include: {
      chapter: { select: { ueId: true } },
    },
  });

  if (!doc) {
    return NextResponse.json(
      { error: "Document introuvable." },
      { status: 404 }
    );
  }

  const isManager = await canManageUE(
    user.id,
    user.globalRole,
    doc.chapter.ueId
  );

  if (!isManager && doc.authorId !== user.id) {
    return NextResponse.json({ error: "Accès refusé." }, { status: 403 });
  }

  try {
    await prisma.document.delete({
      where: { id: doc.id },
    });

    try {
      await fsp.unlink(resolveDocumentFilePath(doc.localPath));
    } catch {
      // Ignore if file already missing
    }

    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error("[Document DELETE] Error:", error);
    return NextResponse.json(
      { error: "Impossible de supprimer le document." },
      { status: 500 }
    );
  }
}
