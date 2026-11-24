import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";

export type ReportStatus = "OPEN" | "RESOLVED" | "DISMISSED";

export interface ContentIssueReportItem {
  id: string;
  reporterId: string;
  reporterName: string;
  ueId: string | null;
  ueCode: string;
  documentId: string | null;
  artifactId: string | null;
  targetKind: string;
  itemLabel: string;
  description: string;
  status: ReportStatus;
  resolvedBy: string | null;
  resolutionNote: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

const globalForReports = globalThis as typeof globalThis & {
  __araContentReportSchemaEnsured?: boolean;
};

export async function ensureContentReportSchema(): Promise<void> {
  if (globalForReports.__araContentReportSchemaEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "ContentIssueReport" (
        "id" TEXT NOT NULL,
        "reporterId" TEXT NOT NULL,
        "reporterName" TEXT NOT NULL,
        "ueId" TEXT,
        "ueCode" TEXT NOT NULL DEFAULT '',
        "documentId" TEXT,
        "artifactId" TEXT,
        "targetKind" TEXT NOT NULL,
        "itemLabel" TEXT NOT NULL,
        "description" TEXT NOT NULL,
        "status" TEXT NOT NULL DEFAULT 'OPEN',
        "resolvedBy" TEXT,
        "resolutionNote" TEXT,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "resolvedAt" TIMESTAMP(3),
        CONSTRAINT "ContentIssueReport_pkey" PRIMARY KEY ("id")
      );
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "ContentIssueReport_status_createdAt_idx"
      ON "ContentIssueReport"("status", "createdAt");
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "ContentIssueReport_ueId_status_idx"
      ON "ContentIssueReport"("ueId", "status");
    `);
    globalForReports.__araContentReportSchemaEnsured = true;
  } catch (err) {
    console.warn("[ContentReports] Schema init warning:", err);
  }
}

export async function createContentIssueReport(params: {
  reporterId: string;
  reporterName: string;
  ueId?: string | null;
  ueCode?: string;
  documentId?: string | null;
  artifactId?: string | null;
  targetKind: string;
  itemLabel: string;
  description: string;
}): Promise<ContentIssueReportItem> {
  await ensureContentReportSchema();

  const id = `rep-${crypto.randomUUID().slice(0, 12)}`;
  const ueId = params.ueId?.trim() || null;
  let ueCode = params.ueCode?.trim().toUpperCase() || "";
  if (!ueCode && ueId) {
    const ue = await prisma.uE
      .findUnique({ where: { id: ueId }, select: { code: true } })
      .catch(() => null);
    if (ue?.code) ueCode = ue.code;
  }
  const documentId = params.documentId?.trim() || null;
  const artifactId = params.artifactId?.trim() || null;
  const targetKind = params.targetKind.trim().toUpperCase().slice(0, 32) || "SUMMARY";
  const itemLabel = params.itemLabel.trim().slice(0, 180) || "Contenu IA";
  const description = params.description.trim().slice(0, 1200);

  await prisma.$executeRaw`
    INSERT INTO "ContentIssueReport" (
      "id", "reporterId", "reporterName", "ueId", "ueCode",
      "documentId", "artifactId", "targetKind", "itemLabel", "description", "status", "createdAt"
    )
    VALUES (
      ${id}, ${params.reporterId}, ${params.reporterName}, ${ueId}, ${ueCode},
      ${documentId}, ${artifactId}, ${targetKind}, ${itemLabel}, ${description}, 'OPEN', NOW()
    )
  `;

  return {
    id,
    reporterId: params.reporterId,
    reporterName: params.reporterName,
    ueId,
    ueCode,
    documentId,
    artifactId,
    targetKind,
    itemLabel,
    description,
    status: "OPEN",
    resolvedBy: null,
    resolutionNote: null,
    createdAt: new Date().toISOString(),
    resolvedAt: null,
  };
}

interface RawReportRow {
  id: string;
  reporterId: string;
  reporterName: string;
  ueId: string | null;
  ueCode: string;
  documentId: string | null;
  artifactId: string | null;
  targetKind: string;
  itemLabel: string;
  description: string;
  status: string;
  resolvedBy: string | null;
  resolutionNote: string | null;
  createdAt: Date | string;
  resolvedAt: Date | string | null;
}

function mapRow(r: RawReportRow): ContentIssueReportItem {
  const status: ReportStatus =
    r.status === "RESOLVED" || r.status === "DISMISSED" ? r.status : "OPEN";
  return {
    id: r.id,
    reporterId: r.reporterId,
    reporterName: r.reporterName,
    ueId: r.ueId,
    ueCode: r.ueCode,
    documentId: r.documentId,
    artifactId: r.artifactId,
    targetKind: r.targetKind,
    itemLabel: r.itemLabel,
    description: r.description,
    status,
    resolvedBy: r.resolvedBy,
    resolutionNote: r.resolutionNote,
    createdAt:
      r.createdAt instanceof Date ? r.createdAt.toISOString() : String(r.createdAt),
    resolvedAt:
      r.resolvedAt instanceof Date
        ? r.resolvedAt.toISOString()
        : r.resolvedAt
        ? String(r.resolvedAt)
        : null,
  };
}

export async function listContentReports(options?: {
  status?: ReportStatus | "ALL";
  ueIds?: string[];
  limit?: number;
}): Promise<ContentIssueReportItem[]> {
  await ensureContentReportSchema();
  const limit = Math.max(1, Math.min(100, options?.limit ?? 40));

  const rows = await prisma.$queryRaw<RawReportRow[]>`
    SELECT "id", "reporterId", "reporterName", "ueId", "ueCode",
           "documentId", "artifactId", "targetKind", "itemLabel",
           "description", "status", "resolvedBy", "resolutionNote",
           "createdAt", "resolvedAt"
    FROM "ContentIssueReport"
    ORDER BY
      CASE WHEN "status" = 'OPEN' THEN 0 ELSE 1 END ASC,
      "createdAt" DESC
    LIMIT ${limit * 2}
  `;

  return rows
    .filter((r) => {
      if (options?.status && options.status !== "ALL" && r.status !== options.status) {
        return false;
      }
      if (options?.ueIds) {
        if (!r.ueId || !options.ueIds.includes(r.ueId)) return false;
      }
      return true;
    })
    .slice(0, limit)
    .map(mapRow);
}

export async function getContentIssueReportById(
  id: string
): Promise<ContentIssueReportItem | null> {
  await ensureContentReportSchema();
  const rows = await prisma.$queryRaw<RawReportRow[]>`
    SELECT "id", "reporterId", "reporterName", "ueId", "ueCode",
           "documentId", "artifactId", "targetKind", "itemLabel",
           "description", "status", "resolvedBy", "resolutionNote",
           "createdAt", "resolvedAt"
    FROM "ContentIssueReport"
    WHERE "id" = ${id}
    LIMIT 1
  `;
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function updateContentIssueReportStatus(params: {
  id: string;
  status: "RESOLVED" | "DISMISSED";
  resolvedBy: string;
  resolutionNote?: string;
}): Promise<ContentIssueReportItem | null> {
  await ensureContentReportSchema();
  const note = params.resolutionNote?.trim().slice(0, 500) || null;
  await prisma.$executeRaw`
    UPDATE "ContentIssueReport"
    SET "status" = ${params.status},
        "resolvedBy" = ${params.resolvedBy},
        "resolutionNote" = ${note},
        "resolvedAt" = NOW()
    WHERE "id" = ${params.id}
  `;
  return getContentIssueReportById(params.id);
}
