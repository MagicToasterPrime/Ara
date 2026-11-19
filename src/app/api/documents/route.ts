import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canManageUE, getCurrentUser } from "@/lib/auth";
import {
  ensureDocumentStatusSchema,
  setDocumentProcessingStatus,
  type DocumentProcessingStatus,
} from "@/lib/document-status";
import { extractPdfPages } from "@/lib/pdf";
import { storeDocumentChunksUnindexed } from "@/lib/ollama";
import { ensureUploadDir, sanitizeFileName } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_BULK_UPLOAD_BYTES = 300 * 1024 * 1024; // 300 Mo

interface PerFileUploadResult {
  index: number;
  fileName: string;
  fileSize: number;
  ok: boolean;
  status: "queued" | "error";
  processingStatus?: DocumentProcessingStatus;
  error?: string;
  document?: Record<string, unknown>;
  indexing?: {
    indexed: boolean;
    chunkCount: number;
    scheduledNightly: boolean;
  };
  scheduledNightly?: boolean;
}

function hasPdfMagicHeader(buffer: Buffer): boolean {
  const head = buffer.subarray(0, Math.min(1024, buffer.byteLength));
  return head.includes(Buffer.from("%PDF-"));
}

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
    await ensureDocumentStatusSchema();

    const formData = await req.formData();
    const chapterId = String(formData.get("chapterId") || "").trim();
    const titleInput = String(formData.get("title") || "").trim();
    const categoryRaw = String(formData.get("category") || "STUDENT_NOTE").trim();

    // Accept both bulk uploads (`files` / `files[]`) and legacy single/multi `file` fields
    const rawEntries = [
      ...formData.getAll("files"),
      ...formData.getAll("files[]"),
      ...formData.getAll("file"),
    ];
    const files = rawEntries.filter(
      (entry): entry is File => entry instanceof File
    );

    if (!chapterId || files.length === 0) {
      return NextResponse.json(
        { error: "Chapitre et au moins un fichier PDF requis." },
        { status: 400 }
      );
    }

    const totalBatchBytes = files.reduce((sum, f) => sum + (f.size || 0), 0);
    if (totalBatchBytes > MAX_BULK_UPLOAD_BYTES) {
      return NextResponse.json(
        {
          error:
            "La taille totale du lot dépasse la limite maximale de 300 Mo. Scindez votre envoi en plusieurs lots.",
        },
        { status: 413 }
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

    const customTitlesRaw = formData.getAll("titles").map((t) => String(t).trim());
    const uploadDir = await ensureUploadDir();
    const results: PerFileUploadResult[] = [];

    // Process each PDF strictly sequentially with full per-file error isolation
    for (let idx = 0; idx < files.length; idx += 1) {
      const file = files[idx];
      const rawName = file.name || `document_${idx + 1}.pdf`;
      const originalName = sanitizeFileName(rawName);
      let writtenAbsolutePath: string | null = null;

      try {
        const isPdf =
          file.type === "application/pdf" ||
          originalName.toLowerCase().endsWith(".pdf");

        if (!isPdf) {
          results.push({
            index: idx,
            fileName: rawName,
            fileSize: file.size || 0,
            ok: false,
            status: "error",
            error: "Format refusé : seuls les fichiers .pdf sont acceptés.",
          });
          continue;
        }

        const arrayBuffer = await file.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        if (buffer.byteLength === 0) {
          console.error(
            `[Documents POST] Fichier vide rejeté : "${rawName}".`
          );
          results.push({
            index: idx,
            fileName: rawName,
            fileSize: 0,
            ok: false,
            status: "error",
            error: "Le fichier PDF est vide (0 octet).",
          });
          continue;
        }

        if (!hasPdfMagicHeader(buffer)) {
          console.error(
            `[Documents POST] En-tête PDF invalide (corrompu) pour "${rawName}".`
          );
          results.push({
            index: idx,
            fileName: rawName,
            fileSize: buffer.byteLength,
            ok: false,
            status: "error",
            error: "Fichier PDF corrompu ou invalide (signature %PDF absente).",
          });
          continue;
        }

        // Extract raw text BEFORE writing to DB so corrupted files never pollute the queue
        const extracted = await extractPdfPages(buffer);
        if (extracted.parseError) {
          console.error(
            `[Documents POST] Impossible de lire le PDF "${rawName}" : ${extracted.parseError}`
          );
          results.push({
            index: idx,
            fileName: rawName,
            fileSize: buffer.byteLength,
            ok: false,
            status: "error",
            error: "Fichier PDF corrompu ou chiffré (lecture impossible).",
          });
          continue;
        }

        const storedName = `${crypto.randomUUID()}_${originalName}`;
        const absoluteTarget = path.join(uploadDir, storedName);
        await fsp.writeFile(absoluteTarget, buffer);
        writtenAbsolutePath = absoluteTarget;

        const relativePath = path.relative(process.cwd(), absoluteTarget);
        const perFileTitle =
          customTitlesRaw[idx] ||
          (files.length === 1 ? titleInput : "") ||
          originalName.replace(/\.pdf$/i, "").replace(/[_-]+/g, " ").trim();

        const doc = await prisma.document.create({
          data: {
            chapterId: chapter.id,
            authorId: user.id,
            title: perFileTitle || originalName,
            fileName: originalName,
            localPath: relativePath,
            mimeType: "application/pdf",
            fileSize: buffer.byteLength,
            category,
            isPinned: false,
            isIndexed: false,
            pageCount: Math.max(1, extracted.pageCount),
          },
          include: {
            author: {
              select: { id: true, name: true, email: true, globalRole: true },
            },
          },
        });

        // Scanned / image-only PDF with zero extractable text: mark in ERROR so nightly AI never runs on it
        if (!extracted.hasExtractableText) {
          const scanErrorMsg =
            "PDF scanné ou sans texte exploitable (marqué en erreur, exclu du batch IA nocturne).";
          console.error(
            `[Documents POST] "${rawName}" (doc ${doc.id}) : ${scanErrorMsg}`
          );
          await setDocumentProcessingStatus(
            doc.id,
            "ERROR",
            "PDF scanné ou sans texte exploitable (OCR requis)"
          );

          results.push({
            index: idx,
            fileName: rawName,
            fileSize: buffer.byteLength,
            ok: false,
            status: "error",
            processingStatus: "ERROR",
            error: scanErrorMsg,
            document: {
              ...doc,
              processingStatus: "ERROR",
              processingError: "PDF scanné ou sans texte exploitable (OCR requis)",
              upvoteCount: 0,
              hasUpvoted: false,
            },
          });
          continue;
        }

        // Valid text-bearing PDF: store raw chunks unindexed and queue for the nightly batch (ZERO Ollama calls here)
        const stored = await storeDocumentChunksUnindexed(
          doc.id,
          extracted.pages
        );

        if (!stored.hasUsableText || stored.chunkCount === 0) {
          const emptyChunkError =
            "Aucun texte exploitable extrait de ce PDF (exclu du batch nocturne).";
          console.error(
            `[Documents POST] "${rawName}" (doc ${doc.id}) : ${emptyChunkError}`
          );
          results.push({
            index: idx,
            fileName: rawName,
            fileSize: buffer.byteLength,
            ok: false,
            status: "error",
            processingStatus: "ERROR",
            error: emptyChunkError,
          });
          continue;
        }

        const docPayload = {
          ...doc,
          processingStatus: "PENDING" as DocumentProcessingStatus,
          processingError: null,
          upvoteCount: 0,
          hasUpvoted: false,
        };

        const indexingResult = {
          indexed: false,
          chunkCount: stored.chunkCount,
          scheduledNightly: true,
        };

        results.push({
          index: idx,
          fileName: rawName,
          fileSize: buffer.byteLength,
          ok: true,
          status: "queued",
          processingStatus: "PENDING",
          document: docPayload,
          indexing: indexingResult,
          scheduledNightly: true,
        });
      } catch (fileErr) {
        console.error(
          `[Documents POST] Erreur isolée sur "${rawName}":`,
          fileErr
        );
        if (writtenAbsolutePath) {
          await fsp.unlink(writtenAbsolutePath).catch(() => null);
        }
        results.push({
          index: idx,
          fileName: rawName,
          fileSize: file.size || 0,
          ok: false,
          status: "error",
          error: "Erreur interne lors de l'enregistrement de ce fichier PDF.",
        });
      }
    }

    const succeededResults = results.filter((r) => r.ok);
    const failedResults = results.filter((r) => !r.ok);
    const firstSucceeded = succeededResults[0];

    const summary = {
      total: results.length,
      succeeded: succeededResults.length,
      failed: failedResults.length,
    };

    if (succeededResults.length === 0) {
      const singleErr =
        failedResults.length === 1
          ? failedResults[0].error
          : "Aucun fichier PDF valide n'a pu être mis en file d'attente.";
      return NextResponse.json(
        {
          error: singleErr,
          documents: [],
          results,
          summary,
        },
        { status: 400 }
      );
    }

    const httpStatus = failedResults.length > 0 ? 207 : 201;

    return NextResponse.json(
      {
        // Backward-compatible single-upload fields
        document: firstSucceeded.document,
        indexing: firstSucceeded.indexing,
        scheduledNightly: Boolean(firstSucceeded.scheduledNightly),
        // Bulk-upload fields
        documents: succeededResults
          .map((r) => r.document)
          .filter(Boolean),
        results,
        summary,
      },
      { status: httpStatus }
    );
  } catch (error) {
    console.error("[Documents POST] Error:", error);
    return NextResponse.json(
      { error: "Erreur lors de l'envoi des documents." },
      { status: 500 }
    );
  }
}
