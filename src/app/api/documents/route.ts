import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManageUE, getCurrentUser } from "@/lib/auth";
import { extractPdfPages } from "@/lib/pdf";
import { indexDocumentPages } from "@/lib/ollama";
import { ensureUploadDir, sanitizeFileName } from "@/lib/storage";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const documents = await prisma.document.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true,
      title: true,
      fileName: true,
      category: true,
      isPinned: true,
      isIndexed: true,
      pageCount: true,
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
    },
  });

  return NextResponse.json({ documents });
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  try {
    const formData = await req.formData();
    const chapterId = String(formData.get("chapterId") || "").trim();
    const titleInput = String(formData.get("title") || "").trim();
    const categoryRaw = String(formData.get("category") || "STUDENT_NOTE").trim();
    const file = formData.get("file");

    if (!chapterId || !(file instanceof File)) {
      return NextResponse.json(
        { error: "Chapitre et fichier PDF requis." },
        { status: 400 }
      );
    }

    const category =
      categoryRaw === "OFFICIAL_COURSE" ? "OFFICIAL_COURSE" : "STUDENT_NOTE";

    const chapter = await prisma.chapter.findUnique({
      where: { id: chapterId },
      select: { id: true, ueId: true },
    });

    if (!chapter) {
      return NextResponse.json(
        { error: "Chapitre introuvable." },
        { status: 404 }
      );
    }

    if (category === "OFFICIAL_COURSE") {
      const allowed = await canManageUE(
        user.id,
        user.globalRole,
        chapter.ueId
      );
      if (!allowed) {
        return NextResponse.json(
          {
            error:
              "Seuls les responsables d'UE ou d'année peuvent publier un cours officiel.",
          },
          { status: 403 }
        );
      }
    }

    const originalName = sanitizeFileName(file.name);
    const isPdf =
      file.type === "application/pdf" ||
      originalName.toLowerCase().endsWith(".pdf");

    if (!isPdf) {
      return NextResponse.json(
        { error: "Seuls les fichiers PDF sont acceptés." },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    if (buffer.byteLength === 0) {
      return NextResponse.json(
        { error: "Le fichier PDF est vide." },
        { status: 400 }
      );
    }

    const uploadDir = await ensureUploadDir();
    const storedName = `${crypto.randomUUID()}_${originalName}`;
    const absoluteTarget = path.join(uploadDir, storedName);
    await fsp.writeFile(absoluteTarget, buffer);

    const relativePath = path.relative(process.cwd(), absoluteTarget);
    const extracted = await extractPdfPages(buffer);

    const docTitle =
      titleInput || originalName.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ");

    const doc = await prisma.document.create({
      data: {
        chapterId: chapter.id,
        authorId: user.id,
        title: docTitle,
        fileName: originalName,
        localPath: relativePath,
        mimeType: "application/pdf",
        fileSize: buffer.byteLength,
        category,
        isPinned: false,
        isIndexed: false,
        pageCount: extracted.pageCount,
      },
      include: {
        author: {
          select: { id: true, name: true, email: true, globalRole: true },
        },
      },
    });

    let indexingResult = { indexed: false, chunkCount: 0 };
    try {
      indexingResult = await indexDocumentPages(doc.id, extracted.pages);
    } catch (indexErr) {
      console.warn("[Documents POST] Indexing fallback (non-fatal):", indexErr);
    }

    const updatedDoc = await prisma.document.findUnique({
      where: { id: doc.id },
      include: {
        author: {
          select: { id: true, name: true, email: true, globalRole: true },
        },
      },
    });

    return NextResponse.json(
      {
        document: {
          ...(updatedDoc || doc),
          upvoteCount: 0,
          hasUpvoted: false,
        },
        indexing: indexingResult,
      },
      { status: 201 }
    );
  } catch (error) {
    console.error("[Documents POST] Error:", error);
    return NextResponse.json(
      { error: "Erreur lors de l'envoi du document." },
      { status: 500 }
    );
  }
}
