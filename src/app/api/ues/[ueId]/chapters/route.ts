import fsp from "node:fs/promises";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManageUE, getCurrentUser } from "@/lib/auth";
import {
  detachChildChapters,
  getUeChapterHierarchyMap,
  parseThemeAndTitle,
  setChapterHierarchyMeta,
} from "@/lib/chapter-hierarchy";
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
    const body = (await req.json()) as {
      title?: string;
      theme?: string;
      parentId?: string | null;
      order?: number;
    };
    const rawTitle = body.title?.trim() || "";
    if (!rawTitle) {
      return NextResponse.json(
        { error: "Le titre du chapitre est requis." },
        { status: 400 }
      );
    }

    const parsed = parseThemeAndTitle(rawTitle, body.theme);
    const title = parsed.title || rawTitle;
    let theme = parsed.theme;

    const existingMap = await getUeChapterHierarchyMap(params.ueId);
    const parentId =
      body.parentId && existingMap.has(body.parentId.trim())
        ? body.parentId.trim()
        : null;

    if (parentId && !theme) {
      theme = existingMap.get(parentId)?.theme || "";
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

    await setChapterHierarchyMeta(chapter.id, { theme, parentId });

    return NextResponse.json(
      { chapter: { ...chapter, theme, parentId } },
      { status: 201 }
    );
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
      theme?: string;
      parentId?: string | null;
      order?: number;
    };
    if (!body.chapterId) {
      return NextResponse.json(
        { error: "chapterId requis" },
        { status: 400 }
      );
    }

    const chapterId = body.chapterId.trim();
    const existingMap = await getUeChapterHierarchyMap(params.ueId);
    if (!existingMap.has(chapterId)) {
      return NextResponse.json(
        { error: "Chapitre introuvable dans cette UE" },
        { status: 404 }
      );
    }

    const updateData: { title?: string; order?: number } = {};
    let themePatch = body.theme;

    if (body.title !== undefined && body.title.trim()) {
      const parsed = parseThemeAndTitle(body.title.trim(), body.theme);
      updateData.title = parsed.title;
      if (themePatch === undefined && parsed.theme) {
        themePatch = parsed.theme;
      }
    }
    if (body.order !== undefined) {
      updateData.order = Number(body.order);
    }

    const chapter =
      Object.keys(updateData).length > 0
        ? await prisma.chapter.update({
            where: { id: chapterId, ueId: params.ueId },
            data: updateData,
          })
        : await prisma.chapter.findUniqueOrThrow({
            where: { id: chapterId },
          });

    let parentPatch: string | null | undefined = body.parentId;
    if (body.parentId !== undefined) {
      if (
        body.parentId &&
        body.parentId.trim() !== chapterId &&
        existingMap.has(body.parentId.trim())
      ) {
        parentPatch = body.parentId.trim();
      } else {
        parentPatch = null;
      }
    }

    await setChapterHierarchyMeta(chapter.id, {
      ...(themePatch !== undefined ? { theme: themePatch } : {}),
      ...(parentPatch !== undefined ? { parentId: parentPatch } : {}),
    });

    const refreshed = await getUeChapterHierarchyMap(params.ueId);
    const meta = refreshed.get(chapter.id);

    return NextResponse.json({
      chapter: {
        ...chapter,
        theme: meta?.theme || "",
        parentId: meta?.parentId || null,
      },
    });
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

    await detachChildChapters(chapterId, params.ueId);

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
