import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { checkOllamaHealth } from "@/lib/ollama";
import { getStorageStats } from "@/lib/storage";
import { getSystemSettings } from "@/lib/system-settings";
import {
  ensureUserAccountSchema,
  getAllUsersAccountMeta,
} from "@/lib/user-schema";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  await ensureUserAccountSchema();

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
    user.globalRole === "YEAR_ADMIN"
      ? getAllUsersAccountMeta()
      : Promise.resolve(null),
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

  const rawUsers =
    user.globalRole === "YEAR_ADMIN"
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

  const publicSettings =
    user.globalRole === "YEAR_ADMIN"
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
  });
}
