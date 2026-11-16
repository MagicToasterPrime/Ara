import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUser } from "@/lib/auth";
import {
  checkOllamaHealth,
  describeImageWithOllama,
  formatVectorLiteral,
  generateEmbedding,
  getOllamaConfig,
} from "@/lib/ollama";

interface RagChunkRow {
  id: string;
  documentId: string;
  content: string;
  pageNumber: number;
  documentTitle: string;
  fileName: string;
  ueId: string;
  ueCode: string;
  similarity?: number;
}

export interface SpixRequestContext {
  mode?: "DOCUMENT" | "UE" | "GLOBAL";
  ueId?: string;
  ueCode?: string;
  ueTitle?: string;
  chapterId?: string;
  chapterTitle?: string;
  documentId?: string;
  documentTitle?: string;
  fileName?: string;
  currentPage?: number;
}

export async function POST(req: Request) {
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ error: "Non authentifié" }, { status: 401 });
  }

  const health = await checkOllamaHealth();
  if (!health.online) {
    return NextResponse.json(
      {
        error: "OLLAMA_OFFLINE",
        message: `Serveur Ollama hors-ligne (${health.host.replace(/^https?:\/\//, "")})`,
      },
      { status: 503 }
    );
  }

  try {
    const body = (await req.json()) as {
      question?: string;
      ueId?: string;
      scope?: "AUTO" | "DOCUMENT" | "UE" | "GLOBAL";
      context?: SpixRequestContext;
      history?: Array<{ role: string; content: string }>;
      pageImagesBase64?: Array<{ pageNumber: number; base64: string }>;
    };

    const question = body.question?.trim() || "";
    const ctx = body.context || {};
    const requestedScope = body.scope || "AUTO";
    const history = Array.isArray(body.history) ? body.history.slice(-6) : [];

    if (!question) {
      return NextResponse.json(
        { error: "La question est requise." },
        { status: 400 }
      );
    }

    const ueId = ctx.ueId?.trim() || body.ueId?.trim() || undefined;
    const documentId = ctx.documentId?.trim() || undefined;
    const currentPage =
      typeof ctx.currentPage === "number" && ctx.currentPage > 0
        ? ctx.currentPage
        : undefined;

    let effectiveScope: "DOCUMENT" | "UE" | "GLOBAL" = "GLOBAL";
    if (requestedScope === "DOCUMENT" && documentId) {
      effectiveScope = "DOCUMENT";
    } else if (requestedScope === "UE" && ueId) {
      effectiveScope = "UE";
    } else if (requestedScope === "GLOBAL") {
      effectiveScope = "GLOBAL";
    } else {
      if (ctx.mode === "DOCUMENT" && documentId) {
        effectiveScope = "DOCUMENT";
      } else if (ueId) {
        effectiveScope = "UE";
      }
    }

    const combinedChunks: RagChunkRow[] = [];
    const seenChunkIds = new Set<string>();

    const pushChunks = (rows: RagChunkRow[]) => {
      for (const row of rows) {
        if (!seenChunkIds.has(row.id)) {
          seenChunkIds.add(row.id);
          combinedChunks.push(row);
        }
      }
    };

    // 1. In DOCUMENT mode, always inject the chunks of the exact page currently being read
    if (effectiveScope === "DOCUMENT" && documentId && currentPage) {
      const activePageRows = await prisma.documentChunk.findMany({
        where: {
          documentId,
          pageNumber: currentPage,
        },
        take: 4,
        include: {
          document: {
            select: {
              id: true,
              title: true,
              fileName: true,
              chapter: {
                select: {
                  ue: { select: { id: true, code: true } },
                },
              },
            },
          },
        },
      });

      pushChunks(
        activePageRows.map((c) => ({
          id: c.id,
          documentId: c.documentId,
          content: c.content,
          pageNumber: c.pageNumber,
          documentTitle: c.document.title,
          fileName: c.document.fileName,
          ueId: c.document.chapter.ue.id,
          ueCode: c.document.chapter.ue.code,
        }))
      );
    }

    // 2. Vector similarity search via pgvector scoped appropriately
    const embedding = await generateEmbedding(question);

    if (embedding) {
      const vectorLiteral = formatVectorLiteral(embedding);
      if (effectiveScope === "DOCUMENT" && documentId) {
        const docVectorRows = await prisma.$queryRaw<RagChunkRow[]>`
          SELECT
            dc."id",
            dc."documentId",
            dc."content",
            dc."pageNumber",
            d."title" AS "documentTitle",
            d."fileName",
            u."id" AS "ueId",
            u."code" AS "ueCode",
            1 - (dc."embedding" <=> CAST(${vectorLiteral} AS vector(768))) AS "similarity"
          FROM "DocumentChunk" dc
          JOIN "Document" d ON d."id" = dc."documentId"
          JOIN "Chapter" c ON c."id" = d."chapterId"
          JOIN "UE" u ON u."id" = c."ueId"
          WHERE dc."embedding" IS NOT NULL
            AND dc."documentId" = ${documentId}
          ORDER BY dc."embedding" <=> CAST(${vectorLiteral} AS vector(768)) ASC
          LIMIT 5
        `;
        pushChunks(docVectorRows);
      } else if (effectiveScope === "UE" && ueId) {
        const ueVectorRows = await prisma.$queryRaw<RagChunkRow[]>`
          SELECT
            dc."id",
            dc."documentId",
            dc."content",
            dc."pageNumber",
            d."title" AS "documentTitle",
            d."fileName",
            u."id" AS "ueId",
            u."code" AS "ueCode",
            1 - (dc."embedding" <=> CAST(${vectorLiteral} AS vector(768))) AS "similarity"
          FROM "DocumentChunk" dc
          JOIN "Document" d ON d."id" = dc."documentId"
          JOIN "Chapter" c ON c."id" = d."chapterId"
          JOIN "UE" u ON u."id" = c."ueId"
          WHERE dc."embedding" IS NOT NULL
            AND u."id" = ${ueId}
          ORDER BY dc."embedding" <=> CAST(${vectorLiteral} AS vector(768)) ASC
          LIMIT 6
        `;
        pushChunks(ueVectorRows);
      } else {
        const globalVectorRows = await prisma.$queryRaw<RagChunkRow[]>`
          SELECT
            dc."id",
            dc."documentId",
            dc."content",
            dc."pageNumber",
            d."title" AS "documentTitle",
            d."fileName",
            u."id" AS "ueId",
            u."code" AS "ueCode",
            1 - (dc."embedding" <=> CAST(${vectorLiteral} AS vector(768))) AS "similarity"
          FROM "DocumentChunk" dc
          JOIN "Document" d ON d."id" = dc."documentId"
          JOIN "Chapter" c ON c."id" = d."chapterId"
          JOIN "UE" u ON u."id" = c."ueId"
          WHERE dc."embedding" IS NOT NULL
          ORDER BY dc."embedding" <=> CAST(${vectorLiteral} AS vector(768)) ASC
          LIMIT 6
        `;
        pushChunks(globalVectorRows);
      }
    }

    // 3. Keyword fallback if vector search returned no extra chunks
    if (combinedChunks.length === 0) {
      const keywords = question
        .split(/\s+/)
        .map((w) => w.replace(/[^a-zA-Z0-9À-ÿ]/g, ""))
        .filter((w) => w.length >= 3)
        .slice(0, 5);

      const fallbackChunks = await prisma.documentChunk.findMany({
        where: {
          ...(effectiveScope === "DOCUMENT" && documentId
            ? { documentId }
            : effectiveScope === "UE" && ueId
            ? { document: { chapter: { ueId } } }
            : {}),
          ...(keywords.length > 0
            ? {
                OR: keywords.map((kw) => ({
                  content: { contains: kw, mode: "insensitive" },
                })),
              }
            : {}),
        },
        take: 6,
        include: {
          document: {
            select: {
              id: true,
              title: true,
              fileName: true,
              chapter: {
                select: {
                  ue: { select: { id: true, code: true } },
                },
              },
            },
          },
        },
      });

      pushChunks(
        fallbackChunks.map((c) => ({
          id: c.id,
          documentId: c.documentId,
          content: c.content,
          pageNumber: c.pageNumber,
          documentTitle: c.document.title,
          fileName: c.document.fileName,
          ueId: c.document.chapter.ue.id,
          ueCode: c.document.chapter.ue.code,
        }))
      );
    }

    const finalChunks = combinedChunks.slice(0, 8);

    const uniqueSourcesMap = new Map<
      string,
      {
        documentId: string;
        documentTitle: string;
        fileName: string;
        pageNumber: number;
        ueId: string;
        ueCode: string;
        label: string;
      }
    >();

    for (const chunk of finalChunks) {
      const key = `${chunk.documentId}:${chunk.pageNumber}`;
      if (!uniqueSourcesMap.has(key)) {
        uniqueSourcesMap.set(key, {
          documentId: chunk.documentId,
          documentTitle: chunk.documentTitle,
          fileName: chunk.fileName,
          pageNumber: chunk.pageNumber,
          ueId: chunk.ueId,
          ueCode: chunk.ueCode,
          label: `[${chunk.fileName.toUpperCase()} · P.${chunk.pageNumber}]`,
        });
      }
    }

    const sources = Array.from(uniqueSourcesMap.values());

    let contextAwarenessLine =
      "L'étudiant consulte actuellement la vue générale de la promotion (toutes les UE).";
    if (effectiveScope === "DOCUMENT" && ctx.documentTitle) {
      contextAwarenessLine = `L'étudiant lit actuellement le cours PDF « ${ctx.documentTitle} » (${ctx.fileName || "document.pdf"})${
        currentPage ? `, à la PAGE ${currentPage}` : ""
      }${ctx.ueCode ? ` dans l'UE ${ctx.ueCode}` : ""}. Réponds en priorité par rapport à ce document et à la page ouverte.`;
    } else if (effectiveScope === "UE" && (ctx.ueCode || ctx.ueTitle)) {
      contextAwarenessLine = `L'étudiant travaille actuellement dans l'UE ${ctx.ueCode || ""} — ${ctx.ueTitle || ""}. Réponds en t'appuyant sur l'ensemble des cours officiels et notes de cette UE.`;
    }

    let visualNote = "";
    if (Array.isArray(body.pageImagesBase64) && body.pageImagesBase64.length > 0) {
      const desc = await describeImageWithOllama(
        body.pageImagesBase64[0].base64,
        question
      );
      if (desc) {
        visualNote = `ANALYSE VISUELLE DE LA PAGE ${body.pageImagesBase64[0].pageNumber} :\n${desc}\n\n---\n\n`;
      }
    }

    const contextBlock =
      visualNote +
      (finalChunks.length > 0
        ? finalChunks
            .map(
              (c, idx) =>
                `Source ${idx + 1}: [${c.fileName.toUpperCase()} · P.${c.pageNumber}] (UE ${c.ueCode} - ${c.documentTitle})\n${c.content}`
            )
            .join("\n\n---\n\n")
        : "Aucun extrait de document PDF indexé trouvé pour ce périmètre.");

    const systemPrompt = `Tu es Spix, l'assistant académique intelligent local de la plateforme Ara.
CONTEXTE UTILISATEUR ACTUEL :
${contextAwarenessLine}

CONSIGNES :
- Réponds en français de manière claire, structurée, scientifique et concise.
- Base-toi prioritairement sur les extraits fournis ci-dessous.
- Cite chaque source utilisée exactement au format [NOM_FICHIER.PDF · P.X].
- Si les extraits ne contiennent pas l'information demandée, indique-le honnêtement.

EXTRAITS DOCUMENTAIRES :
${contextBlock}`;

    const { host, model } = getOllamaConfig();

    const ollamaRes = await fetch(`${host}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: true,
        messages: [
          { role: "system", content: systemPrompt },
          ...history.map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content,
          })),
          { role: "user", content: question },
        ],
      }),
    });

    if (!ollamaRes.ok || !ollamaRes.body) {
      const errorText = await ollamaRes.text().catch(() => "");
      return NextResponse.json(
        {
          error: "OLLAMA_ERROR",
          message:
            errorText ||
            `Erreur Ollama (HTTP ${ollamaRes.status}) pour le modèle ${model}.`,
        },
        { status: 502 }
      );
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const reader = ollamaRes.body.getReader();

    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          encoder.encode(`${JSON.stringify({ type: "sources", sources })}\n`)
        );

        let buffer = "";
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) continue;
              try {
                const parsed = JSON.parse(trimmed) as {
                  message?: { content?: string };
                };
                if (parsed.message?.content) {
                  controller.enqueue(
                    encoder.encode(
                      `${JSON.stringify({
                        type: "token",
                        content: parsed.message.content,
                      })}\n`
                    )
                  );
                }
              } catch {
                // Skip partial JSON line
              }
            }
          }
          controller.enqueue(
            encoder.encode(`${JSON.stringify({ type: "done" })}\n`)
          );
        } catch (err) {
          controller.enqueue(
            encoder.encode(
              `${JSON.stringify({
                type: "error",
                message: err instanceof Error ? err.message : "Erreur stream",
              })}\n`
            )
          );
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
      },
    });
  } catch (error) {
    console.error("[Spix Chat] Error:", error);
    return NextResponse.json(
      { error: "Erreur lors de la requête Spix." },
      { status: 500 }
    );
  }
}
