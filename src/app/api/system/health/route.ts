import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { checkOllamaHealth } from "@/lib/ollama";
import { getStorageStats } from "@/lib/storage";

export async function GET() {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const [ollama, storage, counts] = await Promise.all([
    checkOllamaHealth(),
    getStorageStats(),
    Promise.all([
      prisma.user.count(),
      prisma.uE.count(),
      prisma.document.count(),
      prisma.document.count({ where: { isIndexed: true } }),
      prisma.documentChunk.count(),
      prisma.whiteboard.count(),
      prisma.channel.count(),
    ]),
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

  const users =
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

  return NextResponse.json({
    ollama,
    storage,
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
