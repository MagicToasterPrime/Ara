import { prisma } from "@/lib/prisma";

export type DocumentProcessingStatus = "PENDING" | "READY" | "ERROR";

export interface DocumentStatusMeta {
  processingStatus: DocumentProcessingStatus;
  processingError: string | null;
}

interface RawDocumentStatusRow {
  id: string;
  processingStatus: string | null;
  processingError: string | null;
}

let documentStatusSchemaEnsured = false;

/**
 * Ensures runtime columns "processingStatus" and "processingError" exist on "Document".
 * Strictly 1 SQL command per $executeRawUnsafe call (PostgreSQL 42601 rule).
 */
export async function ensureDocumentStatusSchema(): Promise<void> {
  if (documentStatusSchemaEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "processingStatus" TEXT NOT NULL DEFAULT 'PENDING';
    `);
    await prisma.$executeRawUnsafe(`
      ALTER TABLE "Document" ADD COLUMN IF NOT EXISTS "processingError" TEXT;
    `);
    documentStatusSchemaEnsured = true;
  } catch (err) {
    console.warn("[DocumentStatus] Schema check warning:", err);
  }
}

function normalizeStatus(raw: string | null | undefined): DocumentProcessingStatus {
  const upper = (raw || "").trim().toUpperCase();
  if (upper === "ERROR") return "ERROR";
  if (upper === "READY") return "READY";
  return "PENDING";
}

export async function getDocumentStatusMap(
  documentIds?: string[]
): Promise<Map<string, DocumentStatusMeta>> {
  await ensureDocumentStatusSchema();

  const rows =
    Array.isArray(documentIds) && documentIds.length > 0
      ? await prisma.$queryRaw<RawDocumentStatusRow[]>`
          SELECT "id", "processingStatus", "processingError"
          FROM "Document"
          WHERE "id" = ANY(${documentIds})
        `
      : await prisma.$queryRaw<RawDocumentStatusRow[]>`
          SELECT "id", "processingStatus", "processingError"
          FROM "Document"
        `;

  const map = new Map<string, DocumentStatusMeta>();
  for (const row of rows) {
    map.set(row.id, {
      processingStatus: normalizeStatus(row.processingStatus),
      processingError: row.processingError?.trim() || null,
    });
  }
  return map;
}

export async function setDocumentProcessingStatus(
  documentId: string,
  status: DocumentProcessingStatus,
  errorMessage?: string | null
): Promise<void> {
  await ensureDocumentStatusSchema();
  const cleanError =
    status === "ERROR"
      ? (errorMessage?.trim() || "PDF scanné ou sans texte exploitable.")
      : null;

  await prisma.$executeRaw`
    UPDATE "Document"
    SET "processingStatus" = ${status},
        "processingError" = ${cleanError}
    WHERE "id" = ${documentId}
  `;
}
