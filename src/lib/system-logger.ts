import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";

export type SystemErrorSource =
  | "OLLAMA"
  | "PDF_OCR"
  | "STUDIO"
  | "BACKUP"
  | "QUEUE";

export interface SystemErrorLogEntry {
  id: string;
  source: string;
  message: string;
  detail: string | null;
  documentId: string | null;
  createdAt: string;
}

const globalForLogs = globalThis as typeof globalThis & {
  __araSystemLogSchemaEnsured?: boolean;
};

export async function ensureSystemLogSchema(): Promise<void> {
  if (globalForLogs.__araSystemLogSchemaEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "SystemErrorLog" (
        "id" TEXT NOT NULL,
        "source" TEXT NOT NULL,
        "message" TEXT NOT NULL,
        "detail" TEXT,
        "documentId" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "SystemErrorLog_pkey" PRIMARY KEY ("id")
      );
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "SystemErrorLog_createdAt_idx"
      ON "SystemErrorLog"("createdAt");
    `);
    globalForLogs.__araSystemLogSchemaEnsured = true;
  } catch (err) {
    console.warn("[SystemLogger] Schema init warning:", err);
  }
}

export async function logSystemError(params: {
  source: SystemErrorSource;
  message: string;
  detail?: string;
  documentId?: string;
}): Promise<void> {
  try {
    await ensureSystemLogSchema();
    const id = `errlog-${crypto.randomUUID().slice(0, 12)}`;
    const message = params.message.trim().slice(0, 500) || "Erreur système";
    const detail = params.detail ? params.detail.trim().slice(0, 1500) : null;
    const documentId = params.documentId?.trim() || null;

    await prisma.$executeRaw`
      INSERT INTO "SystemErrorLog" ("id", "source", "message", "detail", "documentId", "createdAt")
      VALUES (${id}, ${params.source}, ${message}, ${detail}, ${documentId}, NOW())
    `;

    // Keep at most the latest 150 entries
    await prisma.$executeRawUnsafe(`
      DELETE FROM "SystemErrorLog"
      WHERE "id" NOT IN (
        SELECT "id" FROM "SystemErrorLog" ORDER BY "createdAt" DESC LIMIT 150
      );
    `);
  } catch (err) {
    console.warn("[SystemLogger] Insert warning:", err);
  }
}

export async function getRecentSystemErrors(
  limit = 25
): Promise<SystemErrorLogEntry[]> {
  try {
    await ensureSystemLogSchema();
    const safeLimit = Math.max(1, Math.min(100, limit));
    const rows = await prisma.$queryRaw<
      Array<{
        id: string;
        source: string;
        message: string;
        detail: string | null;
        documentId: string | null;
        createdAt: Date | string;
      }>
    >`
      SELECT "id", "source", "message", "detail", "documentId", "createdAt"
      FROM "SystemErrorLog"
      ORDER BY "createdAt" DESC
      LIMIT ${safeLimit}
    `;
    return rows.map((r) => ({
      id: r.id,
      source: r.source,
      message: r.message,
      detail: r.detail,
      documentId: r.documentId,
      createdAt:
        r.createdAt instanceof Date
          ? r.createdAt.toISOString()
          : String(r.createdAt),
    }));
  } catch (err) {
    console.warn("[SystemLogger] Query warning:", err);
    return [];
  }
}

export async function clearSystemErrors(): Promise<void> {
  try {
    await ensureSystemLogSchema();
    await prisma.$executeRawUnsafe(`DELETE FROM "SystemErrorLog";`);
  } catch (err) {
    console.warn("[SystemLogger] Clear warning:", err);
  }
}
