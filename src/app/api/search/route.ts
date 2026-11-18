import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import { ensureCommunityQuizSchema } from "@/lib/quiz-schema";
import { getAllUeMetaMap } from "@/lib/ue-meta";

function makeSnippet(text: string, query: string): string {
  const lower = text.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx === -1) return text.slice(0, 140);
  const start = Math.max(0, idx - 45);
  const end = Math.min(text.length, idx + query.length + 85);
  return `${start > 0 ? "…" : ""}${text.slice(start, end)}${
    end < text.length ? "…" : ""
  }`;
}

export async function GET(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const q = searchParams.get("q")?.trim() || "";
  if (q.length < 2) {
    return NextResponse.json({
      ues: [],
      documents: [],
      chunks: [],
      quizzes: [],
      whiteboards: [],
    });
  }

  await ensureCommunityQuizSchema();

  const [ues, ueMetaMap, documents, rawChunks, quizzes, whiteboards] =
    await Promise.all([
      prisma.uE.findMany({
        where: {
          OR: [
            { code: { contains: q, mode: "insensitive" } },
            { title: { contains: q, mode: "insensitive" } },
            { description: { contains: q, mode: "insensitive" } },
          ],
        },
        take: 6,
        orderBy: { code: "asc" },
        select: {
          id: true,
          code: true,
          title: true,
          semester: true,
          accentColor: true,
        },
      }),
      getAllUeMetaMap(),
      prisma.document.findMany({
        where: {
          OR: [
            { title: { contains: q, mode: "insensitive" } },
            { fileName: { contains: q, mode: "insensitive" } },
          ],
        },
        take: 8,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          title: true,
          fileName: true,
          category: true,
          pageCount: true,
          chapter: {
            select: {
              title: true,
              ue: {
                select: { id: true, code: true, title: true },
              },
            },
          },
        },
      }),
      prisma.documentChunk.findMany({
        where: {
          content: { contains: q, mode: "insensitive" },
        },
        take: 14,
        select: {
          id: true,
          documentId: true,
          pageNumber: true,
          content: true,
          document: {
            select: {
              id: true,
              title: true,
              fileName: true,
              chapter: {
                select: {
                  title: true,
                  ue: {
                    select: { id: true, code: true, title: true },
                  },
                },
              },
            },
          },
        },
      }),
      prisma.communityQuiz.findMany({
        where: {
          AND: [
            {
              OR: [{ isPublic: true }, { authorId: user.id }],
            },
            {
              OR: [
                { title: { contains: q, mode: "insensitive" } },
                { description: { contains: q, mode: "insensitive" } },
              ],
            },
          ],
        },
        take: 6,
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          title: true,
          ueId: true,
          ue: { select: { id: true, code: true } },
        },
      }),
      prisma.whiteboard.findMany({
        where: {
          AND: [
            {
              OR: [
                { creatorId: user.id },
                { isPublic: true },
                { isIntegrated: true },
              ],
            },
            {
              title: { contains: q, mode: "insensitive" },
            },
          ],
        },
        take: 6,
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          title: true,
          ue: { select: { id: true, code: true } },
        },
      }),
    ]);

  // Deduplicate PDF page matches by documentId + pageNumber
  const seenPageKey = new Set<string>();
  const chunks: Array<{
    id: string;
    documentId: string;
    documentTitle: string;
    fileName: string;
    pageNumber: number;
    chapterTitle: string;
    ueId: string;
    ueCode: string;
    snippet: string;
  }> = [];

  for (const row of rawChunks) {
    const key = `${row.documentId}:${row.pageNumber}`;
    if (seenPageKey.has(key)) continue;
    seenPageKey.add(key);
    chunks.push({
      id: row.id,
      documentId: row.documentId,
      documentTitle: row.document.title,
      fileName: row.document.fileName,
      pageNumber: row.pageNumber,
      chapterTitle: row.document.chapter.title,
      ueId: row.document.chapter.ue.id,
      ueCode: row.document.chapter.ue.code,
      snippet: makeSnippet(row.content, q),
    });
  }

  return NextResponse.json({
    ues: ues.map((u) => ({
      ...u,
      classLevel: ueMetaMap.get(u.id)?.classLevel ?? "VET2",
    })),
    documents: documents.map((d) => ({
      id: d.id,
      title: d.title,
      fileName: d.fileName,
      category: d.category,
      pageCount: d.pageCount,
      chapterTitle: d.chapter.title,
      ueId: d.chapter.ue.id,
      ueCode: d.chapter.ue.code,
    })),
    chunks,
    quizzes,
    whiteboards,
  });
}
