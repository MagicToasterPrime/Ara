import fsp from "node:fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManageUE, getCurrentUser } from "@/lib/auth";
import { normalizeClassLevel } from "@/lib/class-levels";
import { getUeChapterHierarchyMap } from "@/lib/chapter-hierarchy";
import { resolveDocumentFilePath } from "@/lib/storage";
import { getUeMeta, setUeMeta } from "@/lib/ue-meta";

export async function GET(
  _req: Request,
  { params }: { params: { ueId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const ue = await prisma.uE.findUnique({
    where: { id: params.ueId },
    include: {
      roles: {
        include: {
          user: {
            select: { id: true, name: true, email: true },
          },
        },
      },
      chapters: {
        orderBy: { order: "asc" },
        include: {
          documents: {
            orderBy: [{ isPinned: "desc" }, { createdAt: "desc" }],
            include: {
              author: {
                select: { id: true, name: true, email: true, globalRole: true },
              },
              upvotes: {
                select: { userId: true },
              },
            },
          },
        },
      },
      channels: {
        select: { id: true, name: true, type: true },
      },
      whiteboards: {
        where: {
          OR: [
            { isIntegrated: true },
            { isPublic: true },
            { creatorId: user.id },
          ],
        },
        orderBy: [{ isIntegrated: "desc" }, { updatedAt: "desc" }],
        select: {
          id: true,
          title: true,
          creatorId: true,
          isPublic: true,
          isIntegrated: true,
          updatedAt: true,
          creator: {
            select: { id: true, name: true },
          },
        },
      },
    },
  });

  if (!ue) {
    return NextResponse.json({ error: "UE introuvable" }, { status: 404 });
  }

  // Ensure this UE always has a dedicated UE_CHANNEL
  let channels = ue.channels;
  if (channels.length === 0) {
    const slug = ue.code
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const baseName = `#ue-${slug || ue.id.slice(-4)}`;
    const conflict = await prisma.channel.findUnique({
      where: { name: baseName },
    });
    const createdChannel = await prisma.channel.create({
      data: {
        name: conflict ? `${baseName}-${ue.id.slice(-4)}` : baseName,
        type: "UE_CHANNEL",
        ueId: ue.id,
      },
      select: { id: true, name: true, type: true },
    });
    channels = [createdChannel];
  }

  const [isManager, meta, hierarchyMap] = await Promise.all([
    canManageUE(user.id, user.globalRole, ue.id),
    getUeMeta(ue.id),
    getUeChapterHierarchyMap(ue.id),
  ]);

  const chapters = ue.chapters.map((chapter) => {
    const h = hierarchyMap.get(chapter.id);
    return {
      id: chapter.id,
      ueId: chapter.ueId,
      title: chapter.title,
      theme: h?.theme || "",
      parentId: h?.parentId || null,
      order: chapter.order,
      documents: chapter.documents.map((doc) => ({
        id: doc.id,
        chapterId: doc.chapterId,
        authorId: doc.authorId,
        author: doc.author,
        title: doc.title,
        fileName: doc.fileName,
        mimeType: doc.mimeType,
        fileSize: doc.fileSize,
        category: doc.category,
        isPinned: doc.isPinned,
        isIndexed: doc.isIndexed,
        pageCount: doc.pageCount,
        createdAt: doc.createdAt,
        upvoteCount: doc.upvotes.length,
        hasUpvoted: doc.upvotes.some((u) => u.userId === user.id),
      })),
    };
  });

  return NextResponse.json({
    ue: {
      id: ue.id,
      code: ue.code,
      title: ue.title,
      description: ue.description,
      semester: ue.semester,
      classLevel: meta.classLevel,
      examType: meta.examType,
      examDate: meta.examDate,
      coeff: meta.coeff,
      accentColor: ue.accentColor,
      order: ue.order,
      updatedAt: ue.updatedAt,
      roles: ue.roles,
      chapters,
      channels,
      whiteboards: ue.whiteboards,
    },
    canManage: isManager,
  });
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
      code?: string;
      title?: string;
      description?: string;
      semester?: string;
      classLevel?: string;
      examType?: string;
      examDate?: string | null;
      coeff?: number;
      accentColor?: string;
      order?: number;
    };

    const updated = await prisma.uE.update({
      where: { id: params.ueId },
      data: {
        ...(body.code ? { code: body.code.trim().toUpperCase() } : {}),
        ...(body.title ? { title: body.title.trim() } : {}),
        ...(body.description !== undefined
          ? { description: body.description.trim() }
          : {}),
        ...(body.semester ? { semester: body.semester.trim().toUpperCase() } : {}),
        ...(body.accentColor ? { accentColor: body.accentColor.trim() } : {}),
        ...(body.order !== undefined ? { order: Number(body.order) } : {}),
      },
    });

    await setUeMeta(params.ueId, {
      ...(body.classLevel !== undefined
        ? { classLevel: normalizeClassLevel(body.classLevel) }
        : {}),
      ...(body.examType !== undefined ? { examType: body.examType } : {}),
      ...(body.examDate !== undefined ? { examDate: body.examDate } : {}),
      ...(body.coeff !== undefined ? { coeff: Number(body.coeff) } : {}),
    });

    const meta = await getUeMeta(params.ueId);
    return NextResponse.json({ ue: { ...updated, ...meta } });
  } catch (error) {
    console.error("[UE PATCH] Error:", error);
    return NextResponse.json(
      { error: "Impossible de mettre à jour l'UE." },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _req: Request,
  { params }: { params: { ueId: string } }
) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }
  if (user.globalRole !== "YEAR_ADMIN") {
    return NextResponse.json(
      { error: "Réservé au Responsable d'Année" },
      { status: 403 }
    );
  }

  try {
    const docs = await prisma.document.findMany({
      where: {
        chapter: {
          ueId: params.ueId,
        },
      },
      select: { localPath: true },
    });

    await prisma.uE.delete({
      where: { id: params.ueId },
    });

    for (const doc of docs) {
      try {
        const resolved = resolveDocumentFilePath(doc.localPath);
        await fsp.unlink(resolved);
      } catch {
        // Ignore missing local files during cleanup
      }
    }

    return NextResponse.json({ deleted: true });
  } catch (error) {
    console.error("[UE DELETE] Error:", error);
    return NextResponse.json(
      { error: "Impossible de supprimer l'UE." },
      { status: 500 }
    );
  }
}
