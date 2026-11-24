import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import { prisma } from "@/lib/prisma";
import { setDocumentProcessingStatus } from "@/lib/document-status";
import { logSystemError } from "@/lib/system-logger";
import {
  hasUsableExtractedText,
  hasUsableText,
  normalizePdfExtractedText,
  type ExtractedPdfPage,
} from "@/lib/pdf";

export const DEFAULT_OLLAMA_MODEL = "gemma3:12b";

/**
 * Keep models resident in RAM for 30 minutes across consecutive studio / RAG tasks
 * so Ollama never wastes 15–30s reloading gemma3:12b from disk mid-batch.
 */
export const OLLAMA_KEEP_ALIVE = process.env.OLLAMA_KEEP_ALIVE?.trim() || "30m";

export const EMBED_BATCH_SIZE = 16;

/**
 * Minimum 20 minutes (1200 seconds) timeout for all Ollama HTTP calls
 * so large handouts can be processed reliably on a 4 vCPU / 16 GB RAM CPU VM.
 */
export const OLLAMA_TIMEOUT_MS = Math.max(
  1_200_000,
  Number.parseInt(process.env.OLLAMA_TIMEOUT_MS || "1200000", 10) || 1_200_000
);

export const OLLAMA_DEFAULT_OPTIONS = {
  num_thread: 4,
  temperature: 0.2,
  num_ctx: 6144,
  num_batch: 512,
} as const;

export const OLLAMA_STRICT_SYSTEM_RULE =
  "Ne recopie jamais de texte générique ou d'exemple de structure. Chaque question, proposition de réponse et explication doit être intégralement rédigée en français à partir des faits précis du document fourni.";

export function getOllamaConfig() {
  return {
    host: (process.env.OLLAMA_HOST || "http://127.0.0.1:11434").replace(/\/$/, ""),
    model: process.env.OLLAMA_MODEL || DEFAULT_OLLAMA_MODEL,
    embedModel: process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text",
  };
}

export function getOptimalOllamaThreads(): number {
  const configured = Number.parseInt(process.env.OLLAMA_NUM_THREAD || "", 10);
  if (Number.isFinite(configured) && configured >= 1) {
    return configured;
  }
  const detected = os.cpus()?.length || 0;
  return detected >= 1 ? detected : OLLAMA_DEFAULT_OPTIONS.num_thread;
}

export function getDefaultOllamaNumCtx(): number {
  const configured = Number.parseInt(process.env.OLLAMA_NUM_CTX || "", 10);
  if (Number.isFinite(configured) && configured >= 2048 && configured <= 32768) {
    return configured;
  }
  return OLLAMA_DEFAULT_OPTIONS.num_ctx;
}

export function getOllamaInferenceOptions(overrides?: {
  num_predict?: number;
  repeat_penalty?: number;
  temperature?: number;
  num_ctx?: number;
  num_thread?: number;
  num_batch?: number;
}) {
  return {
    num_thread: overrides?.num_thread ?? getOptimalOllamaThreads(),
    temperature: overrides?.temperature ?? OLLAMA_DEFAULT_OPTIONS.temperature,
    num_ctx: overrides?.num_ctx ?? getDefaultOllamaNumCtx(),
    num_batch: overrides?.num_batch ?? OLLAMA_DEFAULT_OPTIONS.num_batch,
    ...(overrides?.num_predict !== undefined
      ? { num_predict: overrides.num_predict }
      : {}),
    ...(overrides?.repeat_penalty !== undefined
      ? { repeat_penalty: overrides.repeat_penalty }
      : {}),
  };
}

export function getParisHour(date = new Date()): number {
  try {
    const formatted = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Europe/Paris",
      hour: "2-digit",
      hour12: false,
    }).format(date);
    const parsed = Number.parseInt(formatted, 10);
    return Number.isFinite(parsed) ? parsed % 24 : date.getHours();
  } catch {
    return date.getHours();
  }
}

const globalForOllamaLock = globalThis as typeof globalThis & {
  __araOllamaQueueTail?: Promise<void>;
};

/**
 * Global strict sequential mutex (concurrency = 1) for ALL Ollama API calls.
 * Prevents parallel LLM / embedding / vision invocations on CPU-bound VMs.
 */
export function withOllamaLock<T>(task: () => Promise<T>): Promise<T> {
  const tail = globalForOllamaLock.__araOllamaQueueTail || Promise.resolve();
  const run = tail.then(task, task);
  globalForOllamaLock.__araOllamaQueueTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export interface OllamaJsonResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
  errorText: string;
}

/**
 * Native node:http/https JSON POST client for Ollama with full >= 1200s timeout support.
 * Avoids Node's undici fetch default 300s headersTimeout/bodyTimeout ceiling.
 */
export function ollamaPostJson<T>(
  endpointPath: string,
  payload: Record<string, unknown>,
  timeoutMs = OLLAMA_TIMEOUT_MS
): Promise<OllamaJsonResponse<T>> {
  const effectiveTimeout = Math.max(timeoutMs, OLLAMA_TIMEOUT_MS);
  const { host } = getOllamaConfig();
  const url = new URL(
    endpointPath.startsWith("/") ? `${host}${endpointPath}` : `${host}/${endpointPath}`
  );
  const bodyString = JSON.stringify(payload);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finishResolve = (val: OllamaJsonResponse<T>) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      resolve(val);
    };
    const finishReject = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      reject(err);
    };

    const req = transport.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyString, "utf8"),
        },
        timeout: effectiveTimeout,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          const rawText = Buffer.concat(chunks).toString("utf8");
          if (status < 200 || status >= 300) {
            if (status >= 500 || status === 0) {
              void logSystemError({
                source: "OLLAMA",
                message: `Erreur HTTP ${status} sur ${endpointPath}`,
                detail: rawText.slice(0, 600),
              });
            }
            finishResolve({
              ok: false,
              status,
              data: null,
              errorText: rawText,
            });
            return;
          }
          try {
            const parsed = JSON.parse(rawText) as T;
            finishResolve({
              ok: true,
              status,
              data: parsed,
              errorText: "",
            });
          } catch {
            finishResolve({
              ok: false,
              status,
              data: null,
              errorText: "Réponse JSON invalide reçue d'Ollama.",
            });
          }
        });
        res.on("error", (err) => finishReject(err));
      }
    );

    const wallTimer = setTimeout(() => {
      const msg = `Timeout Ollama dépassé (${Math.round(effectiveTimeout / 1000)}s) sur ${endpointPath}`;
      void logSystemError({ source: "OLLAMA", message: msg });
      req.destroy(new Error(msg));
    }, effectiveTimeout);

    req.setTimeout(effectiveTimeout, () => {
      const msg = `Socket timeout Ollama dépassé (${Math.round(effectiveTimeout / 1000)}s) sur ${endpointPath}`;
      void logSystemError({ source: "OLLAMA", message: msg });
      req.destroy(new Error(msg));
    });

    req.on("error", (err) => {
      void logSystemError({
        source: "OLLAMA",
        message: `Erreur réseau Ollama sur ${endpointPath}`,
        detail: err instanceof Error ? err.message : String(err),
      });
      finishReject(err);
    });
    req.write(bodyString);
    req.end();
  });
}

export interface OllamaStreamResponse {
  ok: boolean;
  status: number;
  stream: ReadableStream<Uint8Array> | null;
  errorText: string;
  abort: () => void;
}

/**
 * Native node:http/https streaming POST client for Ollama with full >= 1200s timeout support.
 */
export function ollamaPostStream(
  endpointPath: string,
  payload: Record<string, unknown>,
  timeoutMs = OLLAMA_TIMEOUT_MS,
  externalSignal?: AbortSignal
): Promise<OllamaStreamResponse> {
  const effectiveTimeout = Math.max(timeoutMs, OLLAMA_TIMEOUT_MS);
  const { host } = getOllamaConfig();
  const url = new URL(
    endpointPath.startsWith("/") ? `${host}${endpointPath}` : `${host}/${endpointPath}`
  );
  const bodyString = JSON.stringify(payload);
  const transport = url.protocol === "https:" ? https : http;

  return new Promise((resolve, reject) => {
    let headerSettled = false;
    let cleanedUp = false;

    const cleanup = () => {
      if (cleanedUp) return;
      cleanedUp = true;
      clearTimeout(wallTimer);
      if (externalSignal) {
        externalSignal.removeEventListener("abort", onExternalAbort);
      }
    };

    const req = transport.request(
      url,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(bodyString, "utf8"),
        },
        timeout: effectiveTimeout,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          const errChunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => errChunks.push(chunk));
          res.on("end", () => {
            cleanup();
            if (status >= 500 || status === 0) {
              void logSystemError({
                source: "OLLAMA",
                message: `Erreur stream HTTP ${status} sur ${endpointPath}`,
                detail: Buffer.concat(errChunks).toString("utf8").slice(0, 600),
              });
            }
            if (!headerSettled) {
              headerSettled = true;
              resolve({
                ok: false,
                status,
                stream: null,
                errorText: Buffer.concat(errChunks).toString("utf8"),
                abort: () => req.destroy(),
              });
            }
          });
          res.on("error", (err) => {
            cleanup();
            if (!headerSettled) {
              headerSettled = true;
              reject(err);
            }
          });
          return;
        }

        const webStream = new ReadableStream<Uint8Array>({
          start(controller) {
            let streamClosed = false;
            const safeClose = () => {
              if (streamClosed) return;
              streamClosed = true;
              cleanup();
              try {
                controller.close();
              } catch {
                // Already closed
              }
            };
            const safeError = (err: unknown) => {
              if (streamClosed) return;
              streamClosed = true;
              cleanup();
              try {
                controller.error(err);
              } catch {
                // Already errored/closed
              }
            };

            res.on("data", (chunk: Buffer) => {
              if (!streamClosed) {
                try {
                  controller.enqueue(new Uint8Array(chunk));
                } catch {
                  // Consumer cancelled
                }
              }
            });
            res.on("end", safeClose);
            res.on("close", safeClose);
            res.on("error", safeError);
          },
          cancel() {
            cleanup();
            req.destroy();
          },
        });

        if (!headerSettled) {
          headerSettled = true;
          resolve({
            ok: true,
            status,
            stream: webStream,
            errorText: "",
            abort: () => {
              cleanup();
              req.destroy();
            },
          });
        }
      }
    );

    const onExternalAbort = () => {
      cleanup();
      req.destroy(new Error("Requête Ollama annulée."));
    };

    if (externalSignal) {
      if (externalSignal.aborted) {
        onExternalAbort();
      } else {
        externalSignal.addEventListener("abort", onExternalAbort, { once: true });
      }
    }

    const wallTimer = setTimeout(() => {
      cleanup();
      const msg = `Timeout Ollama dépassé (${Math.round(effectiveTimeout / 1000)}s) sur ${endpointPath}`;
      void logSystemError({ source: "OLLAMA", message: msg });
      req.destroy(new Error(msg));
    }, effectiveTimeout);

    req.setTimeout(effectiveTimeout, () => {
      cleanup();
      const msg = `Socket timeout Ollama dépassé (${Math.round(effectiveTimeout / 1000)}s) sur ${endpointPath}`;
      void logSystemError({ source: "OLLAMA", message: msg });
      req.destroy(new Error(msg));
    });

    req.on("error", (err) => {
      cleanup();
      void logSystemError({
        source: "OLLAMA",
        message: `Erreur stream Ollama sur ${endpointPath}`,
        detail: err instanceof Error ? err.message : String(err),
      });
      if (!headerSettled) {
        headerSettled = true;
        reject(err);
      }
    });

    req.write(bodyString);
    req.end();
  });
}

export interface OllamaHealth {
  online: boolean;
  host: string;
  models: string[];
  configuredModel: string;
  embedModel: string;
  error?: string;
}

const HEALTH_CACHE_TTL_MS = 15_000;

const globalForOllamaCache = globalThis as typeof globalThis & {
  __araOllamaHealthCache?: { value: OllamaHealth; expiresAt: number };
  __araOllamaLegacyEmbedOnly?: boolean;
};

export async function checkOllamaHealth(options?: {
  useCache?: boolean;
}): Promise<OllamaHealth> {
  if (
    options?.useCache &&
    globalForOllamaCache.__araOllamaHealthCache &&
    Date.now() < globalForOllamaCache.__araOllamaHealthCache.expiresAt
  ) {
    return globalForOllamaCache.__araOllamaHealthCache.value;
  }

  const { host, model, embedModel } = getOllamaConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);

  try {
    const res = await fetch(`${host}/api/tags`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!res.ok) {
      const value: OllamaHealth = {
        online: false,
        host,
        models: [],
        configuredModel: model,
        embedModel,
        error: `HTTP ${res.status}`,
      };
      globalForOllamaCache.__araOllamaHealthCache = {
        value,
        expiresAt: Date.now() + 3000,
      };
      return value;
    }
    const json = (await res.json()) as { models?: Array<{ name: string }> };
    const models = (json.models || []).map((m) => m.name);
    const value: OllamaHealth = {
      online: true,
      host,
      models,
      configuredModel: model,
      embedModel,
    };
    globalForOllamaCache.__araOllamaHealthCache = {
      value,
      expiresAt: Date.now() + HEALTH_CACHE_TTL_MS,
    };
    return value;
  } catch {
    const value: OllamaHealth = {
      online: false,
      host,
      models: [],
      configuredModel: model,
      embedModel,
      error: `Serveur Ollama hors-ligne (${host.replace(/^https?:\/\//, "")})`,
    };
    globalForOllamaCache.__araOllamaHealthCache = {
      value,
      expiresAt: Date.now() + 3000,
    };
    return value;
  } finally {
    clearTimeout(timer);
  }
}

async function generateLegacySingleEmbeddingUnlocked(
  text: string,
  embedModel: string
): Promise<number[] | null> {
  try {
    const res = await ollamaPostJson<{ embedding?: number[] }>(
      "/api/embeddings",
      {
        model: embedModel,
        prompt: text,
        keep_alive: OLLAMA_KEEP_ALIVE,
        options: {
          num_thread: getOptimalOllamaThreads(),
        },
      },
      OLLAMA_TIMEOUT_MS
    );

    if (!res.ok || !res.data) {
      return null;
    }
    if (
      !Array.isArray(res.data.embedding) ||
      res.data.embedding.length !== 768
    ) {
      return null;
    }
    return res.data.embedding;
  } catch (err) {
    console.warn("[Ollama] Legacy embedding request error:", err);
    return null;
  }
}

/**
 * Generates embeddings for a batch of chunks in ONE /api/embed HTTP call (3x–6x faster on CPU),
 * with automatic transparent fallback to legacy /api/embeddings if needed.
 */
export async function generateEmbeddingsBatch(
  texts: string[]
): Promise<Array<number[] | null>> {
  if (!Array.isArray(texts) || texts.length === 0) {
    return [];
  }

  const results: Array<number[] | null> = new Array(texts.length).fill(null);
  const validIndexes: number[] = [];
  const validInputs: string[] = [];

  for (let i = 0; i < texts.length; i += 1) {
    const t = (texts[i] || "").trim();
    if (t.length > 0) {
      validIndexes.push(i);
      validInputs.push(t);
    }
  }

  if (validInputs.length === 0) {
    return results;
  }

  return withOllamaLock(async () => {
    const { embedModel } = getOllamaConfig();

    if (!globalForOllamaCache.__araOllamaLegacyEmbedOnly) {
      try {
        const res = await ollamaPostJson<{ embeddings?: number[][] }>(
          "/api/embed",
          {
            model: embedModel,
            input: validInputs,
            keep_alive: OLLAMA_KEEP_ALIVE,
            options: {
              num_thread: getOptimalOllamaThreads(),
            },
          },
          OLLAMA_TIMEOUT_MS
        );

        if (
          res.ok &&
          res.data &&
          Array.isArray(res.data.embeddings) &&
          res.data.embeddings.length === validInputs.length
        ) {
          for (let j = 0; j < validInputs.length; j += 1) {
            const vec = res.data.embeddings[j];
            if (Array.isArray(vec) && vec.length === 768) {
              results[validIndexes[j]] = vec;
            }
          }
          return results;
        }

        if (res.status === 404) {
          globalForOllamaCache.__araOllamaLegacyEmbedOnly = true;
        }
      } catch (err) {
        console.warn("[Ollama] Batch /api/embed warning, falling back:", err);
      }
    }

    // Fallback: sequential legacy /api/embeddings inside the same lock
    for (let j = 0; j < validInputs.length; j += 1) {
      results[validIndexes[j]] = await generateLegacySingleEmbeddingUnlocked(
        validInputs[j],
        embedModel
      );
    }
    return results;
  });
}

export async function generateEmbedding(text: string): Promise<number[] | null> {
  if (!text || !text.trim()) {
    return null;
  }
  const batch = await generateEmbeddingsBatch([text]);
  return batch[0] ?? null;
}

export function chunkPageText(
  text: string,
  chunkSize = 900,
  overlap = 100
): string[] {
  const cleaned = normalizePdfExtractedText(text);
  if (!cleaned) return [];
  if (cleaned.length <= chunkSize) return [cleaned];

  const chunks: string[] = [];
  let start = 0;

  while (start < cleaned.length) {
    let end = Math.min(start + chunkSize, cleaned.length);
    if (end < cleaned.length) {
      const minBreak = start + Math.floor(chunkSize * 0.5);
      const dblNl = cleaned.lastIndexOf("\n\n", end);
      const singleNl = cleaned.lastIndexOf("\n", end);
      const sentEnd = cleaned.lastIndexOf(". ", end);
      const lastSpace = cleaned.lastIndexOf(" ", end);

      if (dblNl > minBreak) {
        end = dblNl;
      } else if (singleNl > minBreak) {
        end = singleNl;
      } else if (sentEnd > minBreak) {
        end = sentEnd + 1;
      } else if (lastSpace > minBreak) {
        end = lastSpace;
      }
    }
    const piece = cleaned.slice(start, end).trim();
    if (piece) {
      chunks.push(piece);
    }
    if (end >= cleaned.length) break;
    const rawNextStart = Math.max(end - overlap, start + 1);
    const alignedSpace = cleaned.indexOf(" ", rawNextStart);
    const nextStart =
      alignedSpace > rawNextStart && alignedSpace < end
        ? alignedSpace + 1
        : rawNextStart;
    start = nextStart > start ? nextStart : start + 1;
  }

  return chunks;
}

export function formatVectorLiteral(embedding: number[]): string {
  const safe = embedding.map((v) => (Number.isFinite(v) ? v : 0));
  return `[${safe.join(",")}]`;
}

export async function storeDocumentChunksUnindexed(
  documentId: string,
  pages: ExtractedPdfPage[]
): Promise<{ chunkCount: number; hasUsableText: boolean }> {
  await prisma.documentChunk.deleteMany({
    where: { documentId },
  });

  if (!hasUsableExtractedText(pages)) {
    console.error(
      `[Ollama] Document ${documentId} sans texte exploitable (PDF scanné ou vide) : marquage en ERROR.`
    );
    await prisma.document.update({
      where: { id: documentId },
      data: { isIndexed: false },
    });
    await setDocumentProcessingStatus(
      documentId,
      "ERROR",
      "PDF scanné ou sans texte exploitable (OCR requis)"
    );
    return { chunkCount: 0, hasUsableText: false };
  }

  const rawChunks: Array<{ content: string; pageNumber: number }> = [];
  for (const page of pages) {
    if (!hasUsableText(page.text, 5)) continue;
    const pieces = chunkPageText(page.text, 900, 100);
    for (const piece of pieces) {
      rawChunks.push({
        content: piece,
        pageNumber: page.pageNumber,
      });
    }
  }

  if (rawChunks.length === 0) {
    console.error(
      `[Ollama] Document ${documentId} : 0 chunk généré après nettoyage — marquage en ERROR.`
    );
    await prisma.document.update({
      where: { id: documentId },
      data: { isIndexed: false },
    });
    await setDocumentProcessingStatus(
      documentId,
      "ERROR",
      "PDF scanné ou sans texte exploitable (OCR requis)"
    );
    return { chunkCount: 0, hasUsableText: false };
  }

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
  await setDocumentProcessingStatus(documentId, "PENDING", null);

  return { chunkCount: rawChunks.length, hasUsableText: true };
}

export async function embedExistingDocumentChunks(
  documentId: string,
  options?: {
    onProgress?: (
      doneChunks: number,
      totalChunks: number,
      chunkMs: number
    ) => void;
    shouldStop?: () => boolean;
  }
): Promise<{
  indexed: boolean;
  chunkCount: number;
  embeddedCount: number;
  stopped: boolean;
  emptyTextError?: boolean;
}> {
  const rows = await prisma.$queryRaw<
    Array<{ id: string; content: string; hasEmbedding: boolean }>
  >`
    SELECT "id", "content", ("embedding" IS NOT NULL) AS "hasEmbedding"
    FROM "DocumentChunk"
    WHERE "documentId" = ${documentId}
    ORDER BY "pageNumber" ASC
  `;

  const combinedText = rows.map((r) => r.content).join(" ");
  if (rows.length === 0 || !hasUsableText(combinedText)) {
    console.error(
      `[Ollama] Indexation annulée pour le document ${documentId} : texte extrait vide ou PDF scanné (aucun appel Ollama).`
    );
    if (rows.length > 0) {
      await prisma.documentChunk.deleteMany({ where: { documentId } });
    }
    await prisma.document.update({
      where: { id: documentId },
      data: { isIndexed: false },
    });
    await setDocumentProcessingStatus(
      documentId,
      "ERROR",
      "PDF scanné ou sans texte exploitable (OCR requis)"
    );
    return {
      indexed: false,
      chunkCount: 0,
      embeddedCount: 0,
      stopped: false,
      emptyTextError: true,
    };
  }

  let embeddedCount = rows.filter((r) => Boolean(r.hasEmbedding)).length;
  let stopped = false;

  const pendingRows = rows.filter((r) => !r.hasEmbedding);
  for (let i = 0; i < pendingRows.length; i += EMBED_BATCH_SIZE) {
    if (options?.shouldStop?.()) {
      stopped = true;
      break;
    }

    const batch = pendingRows.slice(i, i + EMBED_BATCH_SIZE);
    const t0 = Date.now();
    const embeddings = await generateEmbeddingsBatch(
      batch.map((r) => r.content)
    );
    const batchElapsed = Date.now() - t0;

    const updates = [];
    for (let j = 0; j < batch.length; j += 1) {
      const embedding = embeddings[j];
      if (!embedding) continue;
      const vectorLiteral = formatVectorLiteral(embedding);
      updates.push(
        prisma.$executeRaw`
          UPDATE "DocumentChunk"
          SET "embedding" = CAST(${vectorLiteral} AS vector(768))
          WHERE "id" = ${batch[j].id}
        `
      );
    }

    if (updates.length > 0) {
      await prisma.$transaction(updates);
      embeddedCount += updates.length;
    }

    const avgChunkMs = Math.max(
      1,
      Math.round(batchElapsed / Math.max(1, batch.length))
    );
    options?.onProgress?.(embeddedCount, rows.length, avgChunkMs);
  }

  const isIndexed = embeddedCount === rows.length && rows.length > 0;
  await prisma.document.update({
    where: { id: documentId },
    data: { isIndexed },
  });
  await setDocumentProcessingStatus(
    documentId,
    isIndexed ? "READY" : "PENDING",
    null
  );

  return {
    indexed: isIndexed,
    chunkCount: rows.length,
    embeddedCount,
    stopped,
  };
}

export async function indexDocumentPages(
  documentId: string,
  pages: ExtractedPdfPage[],
  onProgress?: (doneChunks: number, totalChunks: number) => void
): Promise<{ indexed: boolean; chunkCount: number; emptyTextError?: boolean }> {
  await prisma.documentChunk.deleteMany({
    where: { documentId },
  });

  if (!hasUsableExtractedText(pages)) {
    console.error(
      `[Ollama] Ré-indexation annulée pour le document ${documentId} : PDF scanné ou sans texte exploitable.`
    );
    await prisma.document.update({
      where: { id: documentId },
      data: { isIndexed: false },
    });
    await setDocumentProcessingStatus(
      documentId,
      "ERROR",
      "PDF scanné ou sans texte exploitable (OCR requis)"
    );
    return { indexed: false, chunkCount: 0, emptyTextError: true };
  }

  const rawChunks: Array<{ content: string; pageNumber: number }> = [];
  for (const page of pages) {
    if (!hasUsableText(page.text, 5)) continue;
    const pieces = chunkPageText(page.text, 900, 100);
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
    await setDocumentProcessingStatus(
      documentId,
      "ERROR",
      "PDF scanné ou sans texte exploitable (OCR requis)"
    );
    return { indexed: false, chunkCount: 0, emptyTextError: true };
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
    await setDocumentProcessingStatus(documentId, "PENDING", null);
    return { indexed: false, chunkCount: rawChunks.length };
  }

  let embeddedCount = 0;

  for (let i = 0; i < rawChunks.length; i += EMBED_BATCH_SIZE) {
    const batch = rawChunks.slice(i, i + EMBED_BATCH_SIZE);
    const embeddings = await generateEmbeddingsBatch(
      batch.map((c) => c.content)
    );

    const ops = [];
    for (let j = 0; j < batch.length; j += 1) {
      const chunk = batch[j];
      const embedding = embeddings[j];
      const id = crypto.randomUUID();
      if (embedding) {
        const vectorLiteral = formatVectorLiteral(embedding);
        ops.push(
          prisma.$executeRaw`
            INSERT INTO "DocumentChunk" ("id", "documentId", "content", "pageNumber", "embedding")
            VALUES (${id}, ${documentId}, ${chunk.content}, ${chunk.pageNumber}, CAST(${vectorLiteral} AS vector(768)))
          `
        );
        embeddedCount += 1;
      } else {
        ops.push(
          prisma.documentChunk.create({
            data: {
              id,
              documentId,
              content: chunk.content,
              pageNumber: chunk.pageNumber,
            },
          })
        );
      }
    }

    if (ops.length > 0) {
      await prisma.$transaction(ops);
    }
    onProgress?.(Math.min(i + batch.length, rawChunks.length), rawChunks.length);
  }

  const isIndexed = embeddedCount > 0 && embeddedCount === rawChunks.length;
  await prisma.document.update({
    where: { id: documentId },
    data: { isIndexed },
  });
  await setDocumentProcessingStatus(
    documentId,
    isIndexed ? "READY" : "PENDING",
    null
  );

  return { indexed: isIndexed, chunkCount: rawChunks.length };
}

export async function describeImageWithOllama(
  imageBase64: string,
  promptContext?: string
): Promise<string | null> {
  return withOllamaLock(async () => {
    const health = await checkOllamaHealth();
    if (!health.online) return null;

    const configuredVision = process.env.OLLAMA_VISION_MODEL?.trim();
    const visionModel =
      (configuredVision &&
        health.models.find((m) => m.startsWith(configuredVision))) ||
      health.models.find((m) =>
        /(vl|llava|vision|moondream|minicpm|gemma3|bakllava)/i.test(m)
      );

    if (!visionModel) {
      return null;
    }

    const cleanBase64 = imageBase64.replace(
      /^data:image\/[a-zA-Z+]+;base64,/,
      ""
    );

    try {
      const res = await ollamaPostJson<{ response?: string }>(
        "/api/generate",
        {
          model: visionModel,
          system: `Tu es un enseignant universitaire vétérinaire qui analyse des figures et schémas de cours. ${OLLAMA_STRICT_SYSTEM_RULE}`,
          prompt: `Analyse cette page/figure de cours universitaire en français. Décris les schémas, organes, courbes, relations fléchées et légendes visibles.${
            promptContext ? ` Contexte demandé : ${promptContext}` : ""
          }`,
          images: [cleanBase64],
          keep_alive: OLLAMA_KEEP_ALIVE,
          stream: false,
          options: getOllamaInferenceOptions({ num_predict: 800 }),
        },
        OLLAMA_TIMEOUT_MS
      );

      if (!res.ok || !res.data) return null;
      return res.data.response?.trim() || null;
    } catch (err) {
      console.warn("[Ollama] Vision analysis error:", err);
      return null;
    }
  });
}
