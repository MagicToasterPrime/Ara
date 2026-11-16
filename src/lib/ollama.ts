import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import type { ExtractedPdfPage } from "@/lib/pdf";

export function getOllamaConfig() {
  return {
    host: (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, ""),
    model: process.env.OLLAMA_MODEL || "qwen2.5:7b",
    embedModel: process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text",
  };
}

export interface OllamaHealth {
  online: boolean;
  host: string;
  models: string[];
  configuredModel: string;
  embedModel: string;
  error?: string;
}

export async function checkOllamaHealth(): Promise<OllamaHealth> {
  const { host, model, embedModel } = getOllamaConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);

  try {
    const res = await fetch(`${host}/api/tags`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      return {
        online: false,
        host,
        models: [],
        configuredModel: model,
        embedModel,
        error: `HTTP ${res.status}`,
      };
    }
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    const models = (json.models || []).map((m) => m.name);
    return {
      online: true,
      host,
      models,
      configuredModel: model,
      embedModel,
    };
  } catch {
    return {
      online: false,
      host,
      models: [],
      configuredModel: model,
      embedModel,
      error: `Serveur Ollama hors-ligne (${host.replace(/^https?:\/\//, "")})`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  const { host, embedModel } = getOllamaConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${host}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: embedModel,
        prompt: text,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as { embedding?: number[] };
    if (!Array.isArray(data.embedding) || data.embedding.length !== 768) {
      return null;
    }
    return data.embedding;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function chunkPageText(
  text: string,
  chunkSize = 800,
  overlap = 100
): string[] {
  const cleaned = text.replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  if (cleaned.length <= chunkSize) return [cleaned];

  const chunks: string[] = [];
  let start = 0;

  while (start < cleaned.length) {
    let end = Math.min(start + chunkSize, cleaned.length);
    if (end < cleaned.length) {
      const lastSpace = cleaned.lastIndexOf(" ", end);
      if (lastSpace > start + Math.floor(chunkSize * 0.5)) {
        end = lastSpace;
      }
    }
    const piece = cleaned.slice(start, end).trim();
    if (piece) {
      chunks.push(piece);
    }
    if (end >= cleaned.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return chunks;
}

export function formatVectorLiteral(embedding: number[]): string {
  const safe = embedding.map((v) => (Number.isFinite(v) ? v : 0));
  return `[${safe.join(",")}]`;
}

export async function indexDocumentPages(
  documentId: string,
  pages: ExtractedPdfPage[]
): Promise<{ indexed: boolean; chunkCount: number }> {
  await prisma.documentChunk.deleteMany({
    where: { documentId },
  });

  const rawChunks: Array<{ content: string; pageNumber: number }> = [];
  for (const page of pages) {
    const pieces = chunkPageText(page.text, 800, 100);
    for (const piece of pieces) {
      rawChunks.push({
        content: piece,
        pageNumber: page.pageNumber,
      });
    }
  }

  if (rawChunks.length === 0) {
    await prisma.document.update({
      where: { id: documentId },
      data: { isIndexed: false },
    });
    return { indexed: false, chunkCount: 0 };
  }

  const health = await checkOllamaHealth();
  if (!health.online) {
    await prisma.documentChunk.createMany({
      data: rawChunks.map((chunk) => ({
        documentId,
        content: chunk.content,
        pageNumber: chunk.pageNumber,
      })),
    });
    await prisma.document.update({
      where: { id: documentId },
      data: { isIndexed: false },
    });
    return { indexed: false, chunkCount: rawChunks.length };
  }

  let embeddedCount = 0;

  for (const chunk of rawChunks) {
    const embedding = await generateEmbedding(chunk.content);
    const id = crypto.randomUUID();
    if (embedding) {
      const vectorLiteral = formatVectorLiteral(embedding);
      await prisma.$executeRaw`
        INSERT INTO "DocumentChunk" ("id", "documentId", "content", "pageNumber", "embedding")
        VALUES (${id}, ${documentId}, ${chunk.content}, ${chunk.pageNumber}, CAST(${vectorLiteral} AS vector(768)))
      `;
      embeddedCount += 1;
    } else {
      await prisma.documentChunk.create({
        data: {
          id,
          documentId,
          content: chunk.content,
          pageNumber: chunk.pageNumber,
        },
      });
    }
  }

  const isIndexed = embeddedCount > 0 && embeddedCount === rawChunks.length;
  await prisma.document.update({
    where: { id: documentId },
    data: { isIndexed },
  });

  return { indexed: isIndexed, chunkCount: rawChunks.length };
}
