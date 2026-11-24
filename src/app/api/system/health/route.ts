import fsp from "node:fs/promises";
import os from "node:os";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { computeDocumentAiQuality } from "@/lib/artifact-quality";
import { getCurrentUser } from "@/lib/auth";
import { getBackupStatus } from "@/lib/backup";
import { listContentReports } from "@/lib/content-reports";
import {
  ensureDocumentStatusSchema,
  getDocumentStatusMap,
} from "@/lib/document-status";
import { checkOcrToolsAvailable } from "@/lib/ocr";
import { checkOllamaHealth } from "@/lib/ollama";
import { getStorageStats } from "@/lib/storage";
import { ensureStudioSchema, isStalePublicArtifact } from "@/lib/studio";
import { getRecentSystemErrors } from "@/lib/system-logger";
import { getSystemSettings } from "@/lib/system-settings";
import {
  ensureUserAccountSchema,
  getAllUsersAccountMeta,
} from "@/lib/user-schema";

async function collectVpsMetrics() {
  const cpus = os.cpus() || [];
  const cores = Math.max(1, cpus.length);
  const loadAvg1m = Number((os.loadavg()[0] || 0).toFixed(2));
  const loadPercent = Math.min(100, Math.round((loadAvg1m / cores) * 100));
  const totalRam = os.totalmem();
  const freeRam = os.freemem();
  const usedRam = Math.max(0, totalRam - freeRam);
  const ramPercent =
    totalRam > 0 ? Math.round((usedRam / totalRam) * 100) : 0;
  const nodeRssBytes = process.memoryUsage().rss;

  let diskTotalBytes = 0;
  let diskFreeBytes = 0;
  let diskUsedPercent = 0;
  try {
    const stat = await fsp.statfs(process.cwd());
    const bsize = Number(stat.bsize || 0);
    diskTotalBytes = Number(stat.blocks || 0) * bsize;
    diskFreeBytes = Number(stat.bavail ?? stat.bfree ?? 0) * bsize;
    const diskUsed = Math.max(0, diskTotalBytes - diskFreeBytes);
    diskUsedPercent =
      diskTotalBytes > 0 ? Math.round((diskUsed / diskTotalBytes) * 100) : 0;
  } catch {
    // statfs unavailable
  }

  let dbSizeBytes = 0;
  try {
    const rows = await prisma.$queryRaw<Array<{ size: bigint | number }>>`
      SELECT pg_database_size(current_database())::bigint AS size
    `;
    dbSizeBytes = Number(rows[0]?.size ?? 0);
  } catch {
    dbSizeBytes = 0;
  }

  const ocr = await checkOcrToolsAvailable();

  return {
    cores,
    loadAvg1m,
    loadPercent,
    totalRamBytes: totalRam,
    usedRamBytes: usedRam,
    ramPercent,
    nodeRssBytes,
    diskTotalBytes,
    diskFreeBytes,
    diskUsedPercent,
    dbSizeBytes,
    uptimeSeconds: Math.round(process.uptime()),
    ocr,
  };
}

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  await ensureUserAccountSchema();

  const isAdmin = user.globalRole === "YEAR_ADMIN";

  const [ollama, storage, settings, counts, metaMap] = await Promise.all([
    checkOllamaHealth(),
    getStorageStats(),
    getSystemSettings(),
    Promise.all([
      prisma.user.count(),
      prisma.uE.count(),
      prisma.document.count(),
      prisma.document.count({ where: { isIndexed: true } }),
      prisma.documentChunk.count(),
      prisma.whiteboard.count(),
      prisma.channel.count(),
    ]),
    isAdmin ? getAllUsersAccountMeta() : Promise.resolve(null),
  ]);

  const [
    userCount,
    ueCount,
    documentCount,
    indexedDocumentCount,
    chunkCount,
    whiteboardCount,
    channelCount,
  ] = counts;

  const rawUsers = isAdmin
    ? await prisma.user.findMany({
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          name: true,
          email: true,
          globalRole: true,
          createdAt: true,
          ueRoles: {
            select: {
              id: true,
              ueId: true,
              role: true,
              ue: {
                select: { id: true, code: true, title: true },
              },
            },
          },
        },
      })
    : undefined;

  const users = rawUsers?.map((u) => {
    const meta = metaMap?.get(u.id);
    return {
      ...u,
      classLevel: meta?.classLevel ?? "VET2",
      isApproved:
        u.globalRole === "YEAR_ADMIN" ? true : (meta?.isApproved ?? true),
    };
  });

  let adminObservability: Record<string, unknown> = {};
  if (isAdmin) {
    await Promise.all([ensureStudioSchema(), ensureDocumentStatusSchema()]);
    const [
      vps,
      backups,
      recentErrors,
      reports,
      allDocs,
      publicArtifacts,
      statusMap,
    ] = await Promise.all([
      collectVpsMetrics(),
      getBackupStatus(),
      getRecentSystemErrors(20),
      listContentReports({ status: "OPEN", limit: 30 }),
      prisma.document.findMany({
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          title: true,
          fileName: true,
          pageCount: true,
          isIndexed: true,
          chapter: {
            select: {
              title: true,
              ue: { select: { id: true, code: true, title: true } },
            },
          },
        },
      }),
      prisma.studyArtifact.findMany({
        where: { isPublic: true, documentId: { not: null } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          documentId: true,
          kind: true,
          contentJson: true,
        },
      }),
      getDocumentStatusMap(),
    ]);

    const artsByDoc = new Map<
      string,
      {
        summary?: { id: string; contentJson: string; stale: boolean };
        flashcards?: { id: string; contentJson: string; stale: boolean };
        quiz?: { id: string; contentJson: string; stale: boolean };
      }
    >();

    for (const art of publicArtifacts) {
      if (!art.documentId) continue;
      const entry = artsByDoc.get(art.documentId) || {};
      const stale = isStalePublicArtifact(art.kind, art.contentJson);
      if (art.kind === "SUMMARY") {
        if (!entry.summary || (entry.summary.stale && !stale)) {
          entry.summary = { id: art.id, contentJson: art.contentJson, stale };
        }
      } else if (art.kind === "FLASHCARDS") {
        if (!entry.flashcards || (entry.flashcards.stale && !stale)) {
          entry.flashcards = { id: art.id, contentJson: art.contentJson, stale };
        }
      } else if (art.kind === "QUIZ") {
        if (!entry.quiz || (entry.quiz.stale && !stale)) {
          entry.quiz = { id: art.id, contentJson: art.contentJson, stale };
        }
      }
      artsByDoc.set(art.documentId, entry);
    }

    const documentQuality = allDocs.map((doc) => {
      const arts = artsByDoc.get(doc.id);
      const st = statusMap.get(doc.id);
      return computeDocumentAiQuality({
        documentId: doc.id,
        title: doc.title,
        fileName: doc.fileName,
        pageCount: doc.pageCount,
        ueId: doc.chapter.ue.id,
        ueCode: doc.chapter.ue.code,
        ueTitle: doc.chapter.ue.title,
        chapterTitle: doc.chapter.title,
        isIndexed: doc.isIndexed,
        processingStatus:
          st?.processingStatus || (doc.isIndexed ? "READY" : "PENDING"),
        summaryArtifact: arts?.summary || null,
        flashcardsArtifact: arts?.flashcards || null,
        quizArtifact: arts?.quiz || null,
      });
    });

    adminObservability = {
      vps,
      backups,
      recentErrors,
      reports,
      documentQuality,
    };
  }

  const publicSettings = isAdmin
    ? settings
    : { ...settings, inviteCode: "" };

  return NextResponse.json({
    ollama,
    storage,
    settings: publicSettings,
    stats: {
      userCount,
      ueCount,
      documentCount,
      indexedDocumentCount,
      chunkCount,
      whiteboardCount,
      channelCount,
    },
    ...(users ? { users } : {}),
    ...adminObservability,
  });
}
