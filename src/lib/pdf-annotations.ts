import { prisma } from "@/lib/prisma";

export interface PdfHighlightRect {
  id: string;
  xPct: number;
  yPct: number;
  wPct: number;
  hPct: number;
}

export interface PdfPageNoteItem {
  id: string;
  pageNumber: number;
  isBookmarked: boolean;
  noteText: string;
  highlights: PdfHighlightRect[];
  updatedAt: string;
}

let pdfAnnotationSchemaEnsured = false;

/**
 * Ensures "PdfPageNote" table exists with strictly 1 SQL statement per $executeRawUnsafe call.
 */
export async function ensurePdfAnnotationSchema(): Promise<void> {
  if (pdfAnnotationSchemaEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "PdfPageNote" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "documentId" TEXT NOT NULL,
        "pageNumber" INTEGER NOT NULL,
        "isBookmarked" BOOLEAN NOT NULL DEFAULT false,
        "noteText" TEXT NOT NULL DEFAULT '',
        "highlightsJson" TEXT NOT NULL DEFAULT '[]',
        "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "PdfPageNote_pkey" PRIMARY KEY ("id")
      );
    `);
    await prisma.$executeRawUnsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS "PdfPageNote_userId_documentId_pageNumber_key"
      ON "PdfPageNote"("userId", "documentId", "pageNumber");
    `);
    pdfAnnotationSchemaEnsured = true;
  } catch (err) {
    console.warn("[PdfAnnotations] Schema check warning:", err);
  }
}

interface RawPdfNoteRow {
  id: string;
  pageNumber: number;
  isBookmarked: boolean;
  noteText: string;
  highlightsJson: string;
  updatedAt: Date | string;
}

export async function getUserPdfAnnotations(
  userId: string,
  documentId: string
): Promise<PdfPageNoteItem[]> {
  await ensurePdfAnnotationSchema();
  const rows = await prisma.$queryRaw<RawPdfNoteRow[]>`
    SELECT "id", "pageNumber", "isBookmarked", "noteText", "highlightsJson", "updatedAt"
    FROM "PdfPageNote"
    WHERE "userId" = ${userId} AND "documentId" = ${documentId}
    ORDER BY "pageNumber" ASC
  `;

  return rows.map((r) => {
    let highlights: PdfHighlightRect[] = [];
    try {
      const parsed = JSON.parse(r.highlightsJson || "[]");
      if (Array.isArray(parsed)) highlights = parsed as PdfHighlightRect[];
    } catch {
      highlights = [];
    }
    return {
      id: r.id,
      pageNumber: r.pageNumber,
      isBookmarked: Boolean(r.isBookmarked),
      noteText: r.noteText || "",
      highlights,
      updatedAt:
        r.updatedAt instanceof Date
          ? r.updatedAt.toISOString()
          : String(r.updatedAt),
    };
  });
}

export async function upsertUserPdfAnnotation(params: {
  userId: string;
  documentId: string;
  pageNumber: number;
  isBookmarked: boolean;
  noteText: string;
  highlights: PdfHighlightRect[];
}): Promise<void> {
  await ensurePdfAnnotationSchema();
  const id = `pn-${crypto.randomUUID()}`;
  const highlightsJson = JSON.stringify(params.highlights || []);
  const noteText = params.noteText ?? "";
  const isBookmarked = Boolean(params.isBookmarked);

  await prisma.$executeRaw`
    INSERT INTO "PdfPageNote" ("id", "userId", "documentId", "pageNumber", "isBookmarked", "noteText", "highlightsJson", "updatedAt")
    VALUES (${id}, ${params.userId}, ${params.documentId}, ${params.pageNumber}, ${isBookmarked}, ${noteText}, ${highlightsJson}, CURRENT_TIMESTAMP)
    ON CONFLICT ("userId", "documentId", "pageNumber")
    DO UPDATE SET
      "isBookmarked" = EXCLUDED."isBookmarked",
      "noteText" = EXCLUDED."noteText",
      "highlightsJson" = EXCLUDED."highlightsJson",
      "updatedAt" = CURRENT_TIMESTAMP
  `;
}
