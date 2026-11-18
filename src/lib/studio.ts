import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { prisma } from "@/lib/prisma";
import {
  checkOllamaHealth,
  describeImageWithOllama,
  embedExistingDocumentChunks,
  formatVectorLiteral,
  generateEmbedding,
  getOllamaConfig,
  storeDocumentChunksUnindexed,
} from "@/lib/ollama";
import { extractPdfPages } from "@/lib/pdf";
import type { RevisionQuestion } from "@/lib/revisions";
import { resolveDocumentFilePath } from "@/lib/storage";

export type StudioArtifactKind =
  | "SVG_DIAGRAM"
  | "FLASHCARDS"
  | "QUIZ"
  | "SUMMARY";

export interface StudioSourceRef {
  documentId: string;
  documentTitle: string;
  fileName: string;
  pageNumber: number;
  ueId: string;
  ueCode: string;
  label: string;
}

export interface SvgNodeSpec {
  id: string;
  code: string;
  label: string;
  detail: string;
  color?: string;
}

export interface SvgEdgeSpec {
  from: string;
  to: string;
  label?: string;
}

export interface SvgDiagramPayload {
  kind: "SVG_DIAGRAM";
  title: string;
  subtitle: string;
  layout: "FLOW" | "HIERARCHY" | "RADIAL";
  nodes: SvgNodeSpec[];
  edges: SvgEdgeSpec[];
  svg: string;
  sources: StudioSourceRef[];
}

export interface FlashcardItem {
  id: string;
  front: string;
  back: string;
  tag: string;
  documentId: string;
  fileName: string;
  pageNumber: number;
  ueId: string;
}

export interface FlashcardsPayload {
  kind: "FLASHCARDS";
  cards: FlashcardItem[];
  sources: StudioSourceRef[];
}

export interface QuizPayload {
  kind: "QUIZ";
  questions: RevisionQuestion[];
  sources: StudioSourceRef[];
}

export interface SummarySection {
  title: string;
  pageRange: string;
  content: string;
  keyPoints: string[];
}

export interface SummaryPayload {
  kind: "SUMMARY";
  overview: string;
  sections?: SummarySection[];
  keyConcepts: Array<{
    term: string;
    definition: string;
    sourceLabel: string;
    documentId: string;
    pageNumber: number;
    ueId: string;
  }>;
  examPitfalls: string[];
  sources: StudioSourceRef[];
}

export type StudioArtifactContent =
  | SvgDiagramPayload
  | FlashcardsPayload
  | QuizPayload
  | SummaryPayload;

let studioSchemaEnsured = false;

export async function ensureStudioSchema() {
  if (studioSchemaEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "StudyArtifact" (
        "id" TEXT NOT NULL,
        "userId" TEXT NOT NULL,
        "ueId" TEXT,
        "documentId" TEXT,
        "kind" TEXT NOT NULL,
        "title" TEXT NOT NULL,
        "prompt" TEXT,
        "contentJson" TEXT NOT NULL,
        "isPublic" BOOLEAN NOT NULL DEFAULT false,
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT "StudyArtifact_pkey" PRIMARY KEY ("id")
      );
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "StudyArtifact_userId_createdAt_idx"
      ON "StudyArtifact"("userId", "createdAt");
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "StudyArtifact_ueId_createdAt_idx"
      ON "StudyArtifact"("ueId", "createdAt");
    `);
    studioSchemaEnsured = true;
  } catch (err) {
    console.warn("[Studio] Schema check warning:", err);
  }
}

interface SourceChunk {
  id: string;
  content: string;
  pageNumber: number;
  documentId: string;
  documentTitle: string;
  fileName: string;
  chapterTitle: string;
  ueId: string;
  ueCode: string;
  ueTitle: string;
}

export async function gatherStudioSourceChunks(params: {
  ueId?: string;
  documentIds?: string[];
  pageNumber?: number;
  prompt?: string;
  fullDocument?: boolean;
}): Promise<SourceChunk[]> {
  const { ueId, documentIds, pageNumber, prompt, fullDocument } = params;
  const docFilter =
    Array.isArray(documentIds) && documentIds.length > 0
      ? documentIds
      : undefined;

  const targetLimit = fullDocument ? 60 : 12;
  const minSubstantialLen = fullDocument ? 60 : 80;

  const collected: SourceChunk[] = [];
  const seen = new Set<string>();

  const pushChunk = (c: SourceChunk) => {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      collected.push(c);
    }
  };

  // 1. If a specific page of a single document is active (targeted mode), prioritize it
  if (
    !fullDocument &&
    docFilter &&
    docFilter.length === 1 &&
    pageNumber &&
    pageNumber > 0
  ) {
    const pageRows = await prisma.documentChunk.findMany({
      where: { documentId: docFilter[0], pageNumber },
      take: 4,
      include: {
        document: {
          select: {
            id: true,
            title: true,
            fileName: true,
            chapter: {
              select: {
                title: true,
                ue: { select: { id: true, code: true, title: true } },
              },
            },
          },
        },
      },
    });
    for (const r of pageRows) {
      pushChunk({
        id: r.id,
        content: r.content,
        pageNumber: r.pageNumber,
        documentId: r.document.id,
        documentTitle: r.document.title,
        fileName: r.document.fileName,
        chapterTitle: r.document.chapter.title,
        ueId: r.document.chapter.ue.id,
        ueCode: r.document.chapter.ue.code,
        ueTitle: r.document.chapter.ue.title,
      });
    }
  }

  // 2. If custom context/prompt is provided in targeted mode, combine vector + keyword search
  if (!fullDocument && prompt && prompt.trim().length > 2) {
    const emb = await generateEmbedding(prompt.trim());
    if (emb) {
      const vec = formatVectorLiteral(emb);
      const vectorRows = docFilter
        ? await prisma.$queryRaw<
            Array<{
              id: string;
              content: string;
              pageNumber: number;
              documentId: string;
              documentTitle: string;
              fileName: string;
              chapterTitle: string;
              ueId: string;
              ueCode: string;
              ueTitle: string;
            }>
          >`
            SELECT dc."id", dc."content", dc."pageNumber",
                   d."id" AS "documentId", d."title" AS "documentTitle", d."fileName",
                   c."title" AS "chapterTitle",
                   u."id" AS "ueId", u."code" AS "ueCode", u."title" AS "ueTitle"
            FROM "DocumentChunk" dc
            JOIN "Document" d ON d."id" = dc."documentId"
            JOIN "Chapter" c ON c."id" = d."chapterId"
            JOIN "UE" u ON u."id" = c."ueId"
            WHERE dc."embedding" IS NOT NULL
              AND d."id" = ANY(${docFilter})
            ORDER BY dc."embedding" <=> CAST(${vec} AS vector(768)) ASC
            LIMIT 8
          `
        : ueId
        ? await prisma.$queryRaw<
            Array<{
              id: string;
              content: string;
              pageNumber: number;
              documentId: string;
              documentTitle: string;
              fileName: string;
              chapterTitle: string;
              ueId: string;
              ueCode: string;
              ueTitle: string;
            }>
          >`
            SELECT dc."id", dc."content", dc."pageNumber",
                   d."id" AS "documentId", d."title" AS "documentTitle", d."fileName",
                   c."title" AS "chapterTitle",
                   u."id" AS "ueId", u."code" AS "ueCode", u."title" AS "ueTitle"
            FROM "DocumentChunk" dc
            JOIN "Document" d ON d."id" = dc."documentId"
            JOIN "Chapter" c ON c."id" = d."chapterId"
            JOIN "UE" u ON u."id" = c."ueId"
            WHERE dc."embedding" IS NOT NULL
              AND u."id" = ${ueId}
            ORDER BY dc."embedding" <=> CAST(${vec} AS vector(768)) ASC
            LIMIT 8
          `
        : await prisma.$queryRaw<
            Array<{
              id: string;
              content: string;
              pageNumber: number;
              documentId: string;
              documentTitle: string;
              fileName: string;
              chapterTitle: string;
              ueId: string;
              ueCode: string;
              ueTitle: string;
            }>
          >`
            SELECT dc."id", dc."content", dc."pageNumber",
                   d."id" AS "documentId", d."title" AS "documentTitle", d."fileName",
                   c."title" AS "chapterTitle",
                   u."id" AS "ueId", u."code" AS "ueCode", u."title" AS "ueTitle"
            FROM "DocumentChunk" dc
            JOIN "Document" d ON d."id" = dc."documentId"
            JOIN "Chapter" c ON c."id" = d."chapterId"
            JOIN "UE" u ON u."id" = c."ueId"
            WHERE dc."embedding" IS NOT NULL
            ORDER BY dc."embedding" <=> CAST(${vec} AS vector(768)) ASC
            LIMIT 8
          `;

      for (const row of vectorRows) {
        pushChunk(row);
      }
    }

    const keywords = Array.from(
      new Set(
        prompt
          .trim()
          .toLowerCase()
          .replace(/[^a-zà-ÿ0-9\s-]/gi, " ")
          .split(/\s+/)
          .filter((w) => w.length >= 4)
      )
    ).slice(0, 6);

    if (keywords.length > 0) {
      const kwRows = await prisma.documentChunk.findMany({
        where: {
          ...(docFilter
            ? { documentId: { in: docFilter } }
            : ueId
            ? { document: { chapter: { ueId } } }
            : {}),
          OR: keywords.map((kw) => ({
            content: { contains: kw, mode: "insensitive" as const },
          })),
        },
        take: 6,
        orderBy: { pageNumber: "asc" },
        include: {
          document: {
            select: {
              id: true,
              title: true,
              fileName: true,
              chapter: {
                select: {
                  title: true,
                  ue: { select: { id: true, code: true, title: true } },
                },
              },
            },
          },
        },
      });
      for (const r of kwRows) {
        pushChunk({
          id: r.id,
          content: r.content,
          pageNumber: r.pageNumber,
          documentId: r.document.id,
          documentTitle: r.document.title,
          fileName: r.document.fileName,
          chapterTitle: r.document.chapter.title,
          ueId: r.document.chapter.ue.id,
          ueCode: r.document.chapter.ue.code,
          ueTitle: r.document.chapter.ue.title,
        });
      }
    }
  }

  // 3. Evenly distribute chunks across the full length of all selected documents
  if (collected.length < targetLimit) {
    const chunkRefs = await prisma.documentChunk.findMany({
      where: docFilter
        ? { documentId: { in: docFilter } }
        : ueId
        ? { document: { chapter: { ueId } } }
        : undefined,
      select: { id: true, documentId: true, pageNumber: true, content: true },
      orderBy: [{ documentId: "asc" }, { pageNumber: "asc" }],
      take: fullDocument ? 1200 : 400,
    });

    const refsByDoc = new Map<
      string,
      Array<{ id: string; substantial: boolean }>
    >();
    for (const ref of chunkRefs) {
      const list = refsByDoc.get(ref.documentId) || [];
      list.push({
        id: ref.id,
        substantial: ref.content.trim().length >= minSubstantialLen,
      });
      refsByDoc.set(ref.documentId, list);
    }

    const docEntries = Array.from(refsByDoc.entries());
    const perDocQuota = Math.max(
      2,
      Math.ceil(
        (targetLimit - collected.length) / Math.max(1, docEntries.length)
      )
    );

    const sampledIds: string[] = [];
    for (const [, list] of docEntries) {
      const preferred = list.filter((item) => item.substantial);
      const sourceList = preferred.length >= 2 ? preferred : list;
      if (sourceList.length <= perDocQuota) {
        for (const item of sourceList) sampledIds.push(item.id);
      } else {
        for (let i = 0; i < perDocQuota; i += 1) {
          const idx = Math.floor(
            (i * (sourceList.length - 1)) / Math.max(1, perDocQuota - 1)
          );
          sampledIds.push(sourceList[idx].id);
        }
      }
    }

    const uniqueSampledIds = Array.from(new Set(sampledIds)).filter(
      (id) => !seen.has(id)
    );

    if (uniqueSampledIds.length > 0) {
      const rows = await prisma.documentChunk.findMany({
        where: { id: { in: uniqueSampledIds.slice(0, targetLimit + 6) } },
        orderBy: [{ documentId: "asc" }, { pageNumber: "asc" }],
        include: {
          document: {
            select: {
              id: true,
              title: true,
              fileName: true,
              chapter: {
                select: {
                  title: true,
                  ue: { select: { id: true, code: true, title: true } },
                },
              },
            },
          },
        },
      });

      for (const r of rows) {
        pushChunk({
          id: r.id,
          content: r.content,
          pageNumber: r.pageNumber,
          documentId: r.document.id,
          documentTitle: r.document.title,
          fileName: r.document.fileName,
          chapterTitle: r.document.chapter.title,
          ueId: r.document.chapter.ue.id,
          ueCode: r.document.chapter.ue.code,
          ueTitle: r.document.chapter.ue.title,
        });
        if (collected.length >= targetLimit) break;
      }
    }
  }

  const finalChunks = collected.slice(0, targetLimit);
  if (fullDocument) {
    finalChunks.sort((a, b) => {
      if (a.documentId !== b.documentId) {
        return a.documentId.localeCompare(b.documentId);
      }
      return a.pageNumber - b.pageNumber;
    });
  }
  return finalChunks;
}

function buildSourceRefs(chunks: SourceChunk[]): StudioSourceRef[] {
  const map = new Map<string, StudioSourceRef>();
  for (const c of chunks) {
    const key = `${c.documentId}:${c.pageNumber}`;
    if (!map.has(key)) {
      map.set(key, {
        documentId: c.documentId,
        documentTitle: c.documentTitle,
        fileName: c.fileName,
        pageNumber: c.pageNumber,
        ueId: c.ueId,
        ueCode: c.ueCode,
        label: `[${c.fileName.toUpperCase()} · P.${c.pageNumber}]`,
      });
    }
  }
  return Array.from(map.values()).slice(0, 6);
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function wrapTextLines(text: string, maxChars: number, maxLines: number): string[] {
  const words = text.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if ((current + " " + word).trim().length <= maxChars) {
      current = (current + " " + word).trim();
    } else {
      if (current) lines.push(current);
      current = word;
      if (lines.length >= maxLines) break;
    }
  }
  if (current && lines.length < maxLines) {
    lines.push(current);
  }
  if (lines.length === maxLines && words.length > 0) {
    const last = lines[lines.length - 1];
    if (last.length > maxChars - 1) {
      lines[lines.length - 1] = `${last.slice(0, maxChars - 1)}…`;
    }
  }
  return lines;
}

const SWISS_COLORS = ["#D99B26", "#3D6B99", "#3B7A57", "#C83E4D"];

export function compileSwissEditorialSvg(params: {
  title: string;
  subtitle: string;
  layout: "FLOW" | "HIERARCHY" | "RADIAL";
  nodes: SvgNodeSpec[];
  edges: SvgEdgeSpec[];
  sources: StudioSourceRef[];
}): string {
  const width = 920;
  const height = 560;
  const nodes = params.nodes.slice(0, 6);
  const count = Math.max(nodes.length, 1);

  // Position nodes cleanly in a grid/flow inside the Swiss Editorial canvas
  const boxW = 240;
  const boxH = 122;
  const positions = new Map<string, { x: number; y: number }>();

  if (params.layout === "HIERARCHY" && count >= 3) {
    // Root at top center, remaining in row(s) below
    positions.set(nodes[0].id, { x: (width - boxW) / 2, y: 98 });
    const rest = nodes.slice(1);
    const cols = Math.min(rest.length, 3);
    const gapX = 36;
    const totalRowW = cols * boxW + (cols - 1) * gapX;
    const startX = (width - totalRowW) / 2;
    rest.forEach((n, idx) => {
      const col = idx % 3;
      const row = Math.floor(idx / 3);
      positions.set(n.id, {
        x: startX + col * (boxW + gapX),
        y: 256 + row * (boxH + 34),
      });
    });
  } else {
    // Clean 2-row flow grid (up to 3 cols per row)
    const cols = count <= 2 ? count : 3;
    const rows = Math.ceil(count / cols);
    const gapX = 48;
    const gapY = 48;
    const totalRowW = cols * boxW + (cols - 1) * gapX;
    const startX = (width - totalRowW) / 2;
    const startY = rows === 1 ? 210 : 120;

    nodes.forEach((n, idx) => {
      const col = idx % cols;
      const row = Math.floor(idx / cols);
      positions.set(n.id, {
        x: startX + col * (boxW + gapX),
        y: startY + row * (boxH + gapY),
      });
    });
  }

  // Grid lines
  const gridLines: string[] = [];
  for (let gx = 40; gx < width; gx += 40) {
    gridLines.push(
      `<line x1="${gx}" y1="74" x2="${gx}" y2="${height - 44}" stroke="#EAE8E0" stroke-width="1" />`
    );
  }
  for (let gy = 80; gy < height - 44; gy += 40) {
    gridLines.push(
      `<line x1="20" y1="${gy}" x2="${width - 20}" y2="${gy}" stroke="#EAE8E0" stroke-width="1" />`
    );
  }

  // Edges
  const edgeElements: string[] = [];
  for (const edge of params.edges) {
    const fromPos = positions.get(edge.from);
    const toPos = positions.get(edge.to);
    if (!fromPos || !toPos) continue;

    const fromCx = fromPos.x + boxW / 2;
    const fromCy = fromPos.y + boxH / 2;
    const toCx = toPos.x + boxW / 2;
    const toCy = toPos.y + boxH / 2;

    const dx = toCx - fromCx;
    const dy = toCy - fromCy;

    let x1 = fromCx;
    let y1 = fromCy;
    let x2 = toCx;
    let y2 = toCy;

    if (Math.abs(dx) >= Math.abs(dy)) {
      x1 = dx >= 0 ? fromPos.x + boxW : fromPos.x;
      x2 = dx >= 0 ? toPos.x - 6 : toPos.x + boxW + 6;
    } else {
      y1 = dy >= 0 ? fromPos.y + boxH : fromPos.y;
      y2 = dy >= 0 ? toPos.y - 6 : toPos.y + boxH + 6;
    }

    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2;

    edgeElements.push(
      `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#1A1A1A" stroke-width="1.5" marker-end="url(#ara-arrow)" />`
    );

    if (edge.label) {
      const cleanLbl = escapeXml(edge.label.slice(0, 26));
      const lblW = Math.max(60, cleanLbl.length * 6.5 + 14);
      edgeElements.push(
        `<rect x="${midX - lblW / 2}" y="${midY - 10}" width="${lblW}" height="18" fill="#F4EFE6" stroke="#DCDAD3" stroke-width="1" />` +
          `<text x="${midX}" y="${midY + 3}" text-anchor="middle" font-family="monospace" font-size="9" fill="#1A1A1A">${cleanLbl.toUpperCase()}</text>`
      );
    }
  }

  // Nodes
  const nodeElements: string[] = [];
  nodes.forEach((node, idx) => {
    const pos = positions.get(node.id);
    if (!pos) return;
    const color = node.color || SWISS_COLORS[idx % SWISS_COLORS.length];
    const codeText = escapeXml((node.code || `N-${idx + 1}`).toUpperCase());
    const labelLines = wrapTextLines(node.label || "Concept", 28, 2);
    const detailLines = wrapTextLines(node.detail || "", 34, 3);

    const labelSvg = labelLines
      .map(
        (line, li) =>
          `<text x="${pos.x + 12}" y="${pos.y + 42 + li * 15}" font-family="sans-serif" font-size="12" font-weight="700" fill="#1A1A1A">${escapeXml(line)}</text>`
      )
      .join("");

    const detailStartY = pos.y + 42 + labelLines.length * 15 + 8;
    const detailSvg = detailLines
      .map(
        (line, li) =>
          `<text x="${pos.x + 12}" y="${detailStartY + li * 13}" font-family="sans-serif" font-size="10.5" fill="#6E6D68">${escapeXml(line)}</text>`
      )
      .join("");

    nodeElements.push(`
      <g>
        <rect x="${pos.x}" y="${pos.y}" width="${boxW}" height="${boxH}" fill="#FCFBF9" stroke="#1A1A1A" stroke-width="1" />
        <rect x="${pos.x}" y="${pos.y}" width="${boxW}" height="4" fill="${escapeXml(color)}" />
        <text x="${pos.x + 12}" y="${pos.y + 22}" font-family="monospace" font-size="10" font-weight="700" fill="${escapeXml(color)}">${codeText}</text>
        ${labelSvg}
        ${detailSvg}
      </g>
    `);
  });

  const sourcesText =
    params.sources.length > 0
      ? params.sources.map((s) => s.label).join(" · ")
      : "SOURCES : DOCUMENTS DE COURS ARA";

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="100%">
  <defs>
    <marker id="ara-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
      <path d="M 0 1 L 10 5 L 0 9 z" fill="#1A1A1A" />
    </marker>
  </defs>
  <rect x="0" y="0" width="${width}" height="${height}" fill="#F7F6F2" />
  <rect x="12" y="12" width="${width - 24}" height="${height - 24}" fill="none" stroke="#DCDAD3" stroke-width="1" />
  ${gridLines.join("\n  ")}
  <!-- Header -->
  <rect x="12" y="12" width="${width - 24}" height="56" fill="#FCFBF9" stroke="#DCDAD3" stroke-width="1" />
  <rect x="12" y="12" width="${width - 24}" height="3" fill="#1A1A1A" />
  <text x="26" y="34" font-family="sans-serif" font-size="15" font-weight="700" fill="#1A1A1A">${escapeXml(params.title.toUpperCase().slice(0, 72))}</text>
  <text x="26" y="53" font-family="monospace" font-size="10" fill="#6E6D68">${escapeXml(params.subtitle.toUpperCase().slice(0, 100))}</text>
  <text x="${width - 26}" y="35" text-anchor="end" font-family="monospace" font-size="10" font-weight="700" fill="#1A1A1A">ARA STUDIO · SVG</text>
  <!-- Edges & Nodes -->
  ${edgeElements.join("\n  ")}
  ${nodeElements.join("\n  ")}
  <!-- Footer -->
  <rect x="12" y="${height - 42}" width="${width - 24}" height="30" fill="#F4EFE6" stroke="#DCDAD3" stroke-width="1" />
  <text x="26" y="${height - 23}" font-family="monospace" font-size="9.5" fill="#2B547E">${escapeXml(sourcesText.slice(0, 120))}</text>
</svg>`;
}

let ollamaQueueTail: Promise<void> = Promise.resolve();

function withOllamaLock<T>(task: () => Promise<T>): Promise<T> {
  const run = ollamaQueueTail.then(task, task);
  ollamaQueueTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function parseLooseJson<T>(raw: string): T | null {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]) as T;
    } catch {
      return null;
    }
  }
}

async function callOllamaJson<T>(
  prompt: string,
  timeoutMs = 120000
): Promise<T | null> {
  return withOllamaLock(async () => {
    const health = await checkOllamaHealth();
    if (!health.online) return null;

    const { host, model } = getOllamaConfig();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${host}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          prompt,
          format: "json",
          stream: false,
          options: {
            temperature: 0.4,
            num_predict: 2800,
          },
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { response?: string };
      if (!data.response) return null;
      return parseLooseJson<T>(data.response);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25);
}

function resolveSourceChunkByPage(
  chunks: SourceChunk[],
  pageHint?: number,
  fallbackIdx = 0
): SourceChunk {
  if (typeof pageHint === "number" && Number.isFinite(pageHint) && pageHint > 0) {
    const exact = chunks.find((c) => c.pageNumber === pageHint);
    if (exact) return exact;
    let closest = chunks[0];
    let bestDist = Infinity;
    for (const c of chunks) {
      const dist = Math.abs(c.pageNumber - pageHint);
      if (dist < bestDist) {
        bestDist = dist;
        closest = c;
      }
    }
    if (closest) return closest;
  }
  return chunks[fallbackIdx % chunks.length];
}

export interface PageImageInput {
  pageNumber: number;
  documentTitle?: string;
  base64: string;
}

function formatChunksForPrompt(
  segmentChunks: SourceChunk[],
  maxCharsPerChunk = 800,
  maxChunks = 10
): string {
  return segmentChunks
    .slice(0, maxChunks)
    .map(
      (c) =>
        `[${c.fileName} · P.${c.pageNumber}] (${c.ueCode} - ${c.chapterTitle})\n${c.content.slice(
          0,
          maxCharsPerChunk
        )}`
    )
    .join("\n\n");
}

function partitionChunks(
  allChunks: SourceChunk[],
  segmentCount: number
): SourceChunk[][] {
  if (allChunks.length === 0) return [];
  if (segmentCount <= 1) return [allChunks];

  if (allChunks.length <= segmentCount) {
    const out: SourceChunk[][] = [];
    for (let i = 0; i < segmentCount; i += 1) {
      out.push([allChunks[i % allChunks.length]]);
    }
    return out;
  }

  const result: SourceChunk[][] = [];
  for (let i = 0; i < segmentCount; i += 1) {
    const start = Math.floor((i * allChunks.length) / segmentCount);
    const end = Math.max(
      start + 1,
      Math.floor(((i + 1) * allChunks.length) / segmentCount)
    );
    result.push(allChunks.slice(start, end));
  }
  return result;
}

function computePageRangeLabel(segmentChunks: SourceChunk[]): string {
  if (segmentChunks.length === 0) return "P.1";
  let minP = Infinity;
  let maxP = 0;
  for (const c of segmentChunks) {
    if (c.pageNumber < minP) minP = c.pageNumber;
    if (c.pageNumber > maxP) maxP = c.pageNumber;
  }
  if (!Number.isFinite(minP)) return "P.1";
  return minP === maxP ? `P.${minP}` : `P.${minP}–${maxP}`;
}

export async function generateStudioArtifact(params: {
  kind: StudioArtifactKind;
  chunks: SourceChunk[];
  title?: string;
  prompt?: string;
  isPublic?: boolean;
  pageImagesBase64?: PageImageInput[];
  onProgress?: (percent: number, detailLabel: string) => void;
  shouldStop?: () => boolean;
}): Promise<{ title: string; content: StudioArtifactContent; usedAi: boolean }> {
  const {
    kind,
    chunks,
    prompt,
    isPublic = false,
    pageImagesBase64,
    onProgress,
    shouldStop,
  } = params;
  const fullCourseMode = Boolean(isPublic);
  const sources = buildSourceRefs(chunks);

  const orderedChunks = fullCourseMode
    ? [...chunks]
    : [
        ...chunks.filter((c) => c.content.includes("[REPÈRE VISUEL")),
        ...chunks.filter((c) => !c.content.includes("[REPÈRE VISUEL")),
      ];

  let visualContextNote = "";
  if (Array.isArray(pageImagesBase64) && pageImagesBase64.length > 0) {
    const descriptions: string[] = [];
    for (const img of pageImagesBase64.slice(0, 2)) {
      const desc = await describeImageWithOllama(img.base64, prompt);
      if (desc) {
        descriptions.push(
          `[ANALYSE VISUELLE PAGE ${img.pageNumber}${
            img.documentTitle ? ` (${img.documentTitle})` : ""
          }]\n${desc}`
        );
      }
    }
    if (descriptions.length > 0) {
      visualContextNote = `${descriptions.join("\n\n")}\n\n`;
    }
  }

  const contextText =
    visualContextNote + formatChunksForPrompt(orderedChunks, 850, 10);

  const defaultTopic =
    prompt?.trim().slice(0, 72) ||
    chunks[0]?.documentTitle ||
    chunks[0]?.ueTitle ||
    "Synthèse de cours";

  const customContextBlock = prompt?.trim()
    ? `\nOBJECTIF ET CONTEXTE PRIORITAIRE DE L'ÉTUDIANT :\n« ${prompt.trim()} »\nAdapte impérativement les explications, exemples et questions à ce que l'étudiant cherche à comprendre.\n`
    : "";

  if (kind === "SVG_DIAGRAM") {
    onProgress?.(20, "Génération du schéma vectoriel .SVG...");
    const aiDiagram = await callOllamaJson<{
      title?: string;
      subtitle?: string;
      layout?: "FLOW" | "HIERARCHY" | "RADIAL";
      nodes?: SvgNodeSpec[];
      edges?: SvgEdgeSpec[];
    }>(
      `Tu es Spix, professeur universitaire vétérinaire. À partir des extraits de cours ci-dessous, conçois un schéma conceptuel clair en français qui aide à comprendre la logique et les relations entre notions sur : "${defaultTopic}".
${customContextBlock}
Réponds STRICTEMENT en JSON :
{
  "title": "Titre court du schéma",
  "subtitle": "Sous-titre académique",
  "layout": "FLOW",
  "nodes": [
    { "id": "n1", "code": "01 / ÉTAPE", "label": "Nom court", "detail": "Explication concise en 10 mots" }
  ],
  "edges": [
    { "from": "n1", "to": "n2", "label": "relation" }
  ]
}
Contraintes : 4 à 6 nœuds maximum, ids n1..n6.

EXTRAITS :
${contextText}`
    );

    let nodes: SvgNodeSpec[] = [];
    let edges: SvgEdgeSpec[] = [];
    let diagramTitle = params.title?.trim() || `Schéma : ${defaultTopic}`;
    let subtitle = `${chunks[0]?.ueCode || "ARA"} · ${chunks[0]?.documentTitle || "COURS"}`;
    let layout: "FLOW" | "HIERARCHY" | "RADIAL" = "FLOW";
    let usedAi = false;

    if (
      aiDiagram?.nodes &&
      Array.isArray(aiDiagram.nodes) &&
      aiDiagram.nodes.length >= 2
    ) {
      usedAi = true;
      nodes = aiDiagram.nodes.slice(0, 6).map((n, idx) => ({
        id: n.id || `n${idx + 1}`,
        code: n.code || `0${idx + 1}`,
        label: n.label || `Concept ${idx + 1}`,
        detail: n.detail || "",
        color: SWISS_COLORS[idx % SWISS_COLORS.length],
      }));
      edges = Array.isArray(aiDiagram.edges) ? aiDiagram.edges : [];
      if (aiDiagram.title) diagramTitle = aiDiagram.title;
      if (aiDiagram.subtitle) subtitle = aiDiagram.subtitle;
      if (
        aiDiagram.layout === "HIERARCHY" ||
        aiDiagram.layout === "RADIAL" ||
        aiDiagram.layout === "FLOW"
      ) {
        layout = aiDiagram.layout;
      }
    } else {
      const usedChunks = chunks.slice(0, 5);
      nodes = usedChunks.map((c, idx) => {
        const sents = splitSentences(c.content);
        const firstSent = sents[0] || c.content.slice(0, 90);
        const shortLabel =
          firstSent.split(/\s+/).slice(0, 5).join(" ") || c.chapterTitle;
        return {
          id: `n${idx + 1}`,
          code: `${c.ueCode} · P.${c.pageNumber}`,
          label: shortLabel,
          detail: firstSent,
          color: SWISS_COLORS[idx % SWISS_COLORS.length],
        };
      });
      edges = nodes.slice(0, -1).map((n, idx) => ({
        from: n.id,
        to: nodes[idx + 1].id,
        label: "suite",
      }));
    }

    const svg = compileSwissEditorialSvg({
      title: diagramTitle,
      subtitle,
      layout,
      nodes,
      edges,
      sources,
    });

    onProgress?.(100, "Schéma .SVG terminé");
    return {
      title: diagramTitle,
      usedAi,
      content: {
        kind: "SVG_DIAGRAM",
        title: diagramTitle,
        subtitle,
        layout,
        nodes,
        edges,
        svg,
        sources,
      },
    };
  }

  if (kind === "FLASHCARDS") {
    const targetCount = fullCourseMode ? 60 : 10;
    const title =
      params.title?.trim() ||
      (fullCourseMode
        ? `60 Flashcards — ${chunks[0]?.documentTitle || defaultTopic}`
        : `Flashcards ciblées : ${defaultTopic}`);

    const segments = fullCourseMode
      ? partitionChunks(orderedChunks, 6)
      : [orderedChunks.slice(0, 10)];

    const cards: FlashcardItem[] = [];
    const seenFronts = new Set<string>();
    let anyAiUsed = false;

    for (let sIdx = 0; sIdx < segments.length; sIdx += 1) {
      if (shouldStop?.() || cards.length >= targetCount) break;

      const segChunks = segments[sIdx];
      const pageSpan = computePageRangeLabel(segChunks);
      onProgress?.(
        Math.round((sIdx / segments.length) * 100),
        `Flashcards (${pageSpan} · Lot ${sIdx + 1}/${segments.length})`
      );

      const segContext = formatChunksForPrompt(segChunks, 820, 10);
      const countForPass = fullCourseMode ? "10 à 12" : "10";
      const scopeHint = fullCourseMode
        ? `PARTIE ${sIdx + 1}/${segments.length} DU COURS (${pageSpan}) : couvre exhaustivement toutes les notions de ces pages (objectif global : 95 % du cours sur les ${segments.length} lots).`
        : "Focus ciblé et pointu sur la difficulté ou notion demandée.";

      const aiCards = await callOllamaJson<{
        cards?: Array<{
          front?: string;
          back?: string;
          tag?: string;
          sourcePage?: number;
        }>;
      }>(
        `Tu es Spix, professeur universitaire vétérinaire. Génère exactement ${countForPass} flashcards distinctes de RÉVISION ACTIVE et de COMPRÉHENSION en français basées sur ces extraits.
${scopeHint}
${customContextBlock}
RÈGLES PÉDAGOGIQUES STRICTES :
- Chaque RECTO ("front") pose une question précise testant un mécanisme, une cause/conséquence, un critère différentiel, un rôle ou un seuil clé.
- Chaque VERSO ("back") donne une réponse complète, claire et rigoureuse (1 à 3 phrases) tirée du cours.
- Aucun doublon avec les autres lots, et indique "sourcePage" (numéro de page de l'extrait).

Réponds STRICTEMENT en JSON :
{
  "cards": [
    {
      "front": "Pourquoi / Comment / Quel mécanisme ... ?",
      "back": "Explication claire, mécanisme précis et conséquence clé.",
      "tag": "MÉCANISME",
      "sourcePage": 1
    }
  ]
}

EXTRAITS :
${segContext}`
      );

      if (aiCards?.cards && Array.isArray(aiCards.cards) && aiCards.cards.length > 0) {
        anyAiUsed = true;
        for (let idx = 0; idx < aiCards.cards.length; idx += 1) {
          const c = aiCards.cards[idx];
          if (!c.front || !c.back) continue;
          const cleanFront = String(c.front).trim();
          const normKey = cleanFront.toLowerCase().slice(0, 60);
          if (seenFronts.has(normKey)) continue;
          seenFronts.add(normKey);

          const src = resolveSourceChunkByPage(segChunks, c.sourcePage, idx);
          cards.push({
            id: `fc-${cards.length + 1}-${crypto.randomUUID().slice(0, 4)}`,
            front: cleanFront,
            back: String(c.back).trim(),
            tag: String(c.tag || src?.ueCode || "COURS").trim(),
            documentId: src?.documentId || "",
            fileName: src?.fileName || "document.pdf",
            pageNumber: src?.pageNumber || 1,
            ueId: src?.ueId || "",
          });
          if (cards.length >= targetCount) break;
        }
      }
    }

    // Complete remaining slots only if non-AI fallback or slight AI shortfall during interactive mode
    if (cards.length < targetCount && (anyAiUsed || !shouldStop?.())) {
      const sentencePool: Array<{ chunk: SourceChunk; sent: string }> = [];
      for (const c of orderedChunks) {
        const sents = splitSentences(c.content);
        if (sents.length > 0) {
          for (const s of sents) sentencePool.push({ chunk: c, sent: s });
        } else if (c.content.trim().length > 20) {
          sentencePool.push({ chunk: c, sent: c.content.trim().slice(0, 220) });
        }
      }
      if (sentencePool.length > 0) {
        let cursor = 0;
        const maxFallbackFill = anyAiUsed
          ? targetCount
          : Math.min(targetCount, sentencePool.length);
        while (cards.length < maxFallbackFill && cursor < targetCount * 2) {
          const entry = sentencePool[cursor % sentencePool.length];
          cursor += 1;
          const frontText = `Notion clé (${entry.chunk.chapterTitle}, p.${entry.chunk.pageNumber} · #${cards.length + 1}) : quel élément faut-il maîtriser ?`;
          const normKey = frontText.toLowerCase().slice(0, 60);
          if (seenFronts.has(normKey)) continue;
          seenFronts.add(normKey);
          cards.push({
            id: `fc-${cards.length + 1}`,
            front: frontText,
            back: entry.sent,
            tag: entry.chunk.ueCode,
            documentId: entry.chunk.documentId,
            fileName: entry.chunk.fileName,
            pageNumber: entry.chunk.pageNumber,
            ueId: entry.chunk.ueId,
          });
        }
      }
    }

    onProgress?.(100, `${cards.length} flashcards générées`);
    return {
      title,
      usedAi: anyAiUsed,
      content: {
        kind: "FLASHCARDS",
        cards: cards.slice(0, targetCount),
        sources,
      },
    };
  }

  if (kind === "QUIZ") {
    const targetCount = fullCourseMode ? 30 : 6;
    const title =
      params.title?.trim() ||
      (fullCourseMode
        ? `Quiz complet (30 Q) — ${chunks[0]?.documentTitle || defaultTopic}`
        : `Quiz ciblé : ${defaultTopic}`);

    const segments = fullCourseMode
      ? partitionChunks(orderedChunks, 6)
      : [orderedChunks.slice(0, 10)];

    const questions: RevisionQuestion[] = [];
    const seenPrompts = new Set<string>();
    let anyAiUsed = false;

    for (let sIdx = 0; sIdx < segments.length; sIdx += 1) {
      if (shouldStop?.() || questions.length >= targetCount) break;

      const segChunks = segments[sIdx];
      const pageSpan = computePageRangeLabel(segChunks);
      onProgress?.(
        Math.round((sIdx / segments.length) * 100),
        `Quiz (${pageSpan} · Lot ${sIdx + 1}/${segments.length})`
      );

      const segContext = formatChunksForPrompt(segChunks, 820, 10);
      const batchSize = fullCourseMode ? 5 : 6;
      const scopeHint = fullCourseMode
        ? `PARTIE ${sIdx + 1}/${segments.length} DU COURS (${pageSpan}) : interroge en profondeur cette portion pour couvrir 95 % du cours sur les ${segments.length} lots.`
        : "Focus ciblé et exigeant sur ce que l'étudiant cherche à comprendre.";

      const aiQuiz = await callOllamaJson<{
        questions?: Array<{
          type?: "QCU" | "QCM" | "QROC" | "FILL_BLANK";
          prompt?: string;
          options?: string[];
          correctIndices?: number[];
          sentenceWithBlank?: string;
          correctAnswer?: string;
          acceptedKeywords?: string[];
          distractors?: string[];
          explanation?: string;
          sourcePage?: number;
        }>;
      }>(
        `Tu es Spix, professeur universitaire vétérinaire. Génère un QUIZ ORIGINAL de ${batchSize} questions en français conçu pour vérifier que l'étudiant a COMPRIS les notions et mécanismes des extraits ci-dessous.
${scopeHint}
${customContextBlock}
RÈGLES PÉDAGOGIQUES STRICTES :
1. NE JAMAIS recopier une phrase brute en demandant « quelle phrase figure dans le cours ».
2. Pose des questions de COMPRÉHENSION et de RAISONNEMENT : mécanismes, relations cause -> effet, scénarios ("Que se passe-t-il si... ?"), comparaisons, cas pratiques/cliniques, et pièges classiques.
3. Varie les formats sur ces ${batchSize} questions : inclus des "QCU" (1 bonne réponse parmi 4), des "QCM" (2 ou 3 bonnes réponses parmi 4), et au moins 1 "QROC" (question ouverte courte dont la réponse tient en 1 à 5 mots).
4. Chaque "explanation" doit justifier clairement pourquoi la bonne réponse est exacte et pourquoi les distracteurs sont faux.

Réponds STRICTEMENT en JSON :
{
  "questions": [
    {
      "type": "QCU",
      "prompt": "Question originale de compréhension ou mise en situation ?",
      "options": ["Proposition A", "Proposition B", "Proposition C", "Proposition D"],
      "correctIndices": [0],
      "explanation": "Justification pédagogique précise.",
      "sourcePage": 2
    },
    {
      "type": "QCM",
      "prompt": "Parmi les affirmations suivantes sur ce mécanisme, lesquelles sont exactes ?",
      "options": ["Prop 1", "Prop 2", "Prop 3", "Prop 4"],
      "correctIndices": [0, 2],
      "explanation": "Justification pédagogique.",
      "sourcePage": 4
    },
    {
      "type": "QROC",
      "prompt": "Question ouverte courte vérifiant une notion clé ?",
      "correctAnswer": "Réponse courte attendue",
      "acceptedKeywords": ["motcle1", "synonyme"],
      "explanation": "Justification pédagogique.",
      "sourcePage": 5
    }
  ]
}

EXTRAITS :
${segContext}`
      );

      if (aiQuiz?.questions && Array.isArray(aiQuiz.questions) && aiQuiz.questions.length > 0) {
        for (let idx = 0; idx < aiQuiz.questions.length; idx += 1) {
          if (questions.length >= targetCount) break;
          const q = aiQuiz.questions[idx];
          const src = resolveSourceChunkByPage(segChunks, q.sourcePage, idx);
          if (!src || !q.prompt) continue;

          const cleanPrompt = q.prompt.trim();
          const promptKey = cleanPrompt.toLowerCase().slice(0, 60);
          if (seenPrompts.has(promptKey)) continue;

          if (
            (q.type === "QCU" || q.type === "QCM") &&
            Array.isArray(q.options) &&
            q.options.length === 4 &&
            Array.isArray(q.correctIndices)
          ) {
            const validIndices = Array.from(
              new Set(
                q.correctIndices.filter(
                  (i) => typeof i === "number" && i >= 0 && i < 4
                )
              )
            ).sort((a, b) => a - b);

            if (validIndices.length > 0) {
              seenPrompts.add(promptKey);
              anyAiUsed = true;
              questions.push({
                id: `sq-${questions.length + 1}`,
                type: q.type,
                ueId: src.ueId,
                ueCode: src.ueCode,
                ueTitle: src.ueTitle,
                chapterTitle: src.chapterTitle,
                documentId: src.documentId,
                documentTitle: src.documentTitle,
                fileName: src.fileName,
                pageNumber: src.pageNumber,
                prompt: cleanPrompt,
                options: q.options.map((o) => String(o).trim()),
                correctIndices:
                  q.type === "QCU" ? [validIndices[0]] : validIndices,
                explanation:
                  q.explanation?.trim() ||
                  `Source : ${src.documentTitle} (p.${src.pageNumber}).`,
                generatedByAi: true,
              });
            }
          } else if (
            q.type === "QROC" &&
            typeof q.correctAnswer === "string" &&
            q.correctAnswer.trim().length > 0
          ) {
            seenPrompts.add(promptKey);
            anyAiUsed = true;
            const mainAnswer = q.correctAnswer.trim();
            const kw = Array.isArray(q.acceptedKeywords)
              ? q.acceptedKeywords
                  .map((k) => String(k).trim())
                  .filter((k) => k.length > 0)
              : [];
            questions.push({
              id: `sq-${questions.length + 1}`,
              type: "QROC",
              ueId: src.ueId,
              ueCode: src.ueCode,
              ueTitle: src.ueTitle,
              chapterTitle: src.chapterTitle,
              documentId: src.documentId,
              documentTitle: src.documentTitle,
              fileName: src.fileName,
              pageNumber: src.pageNumber,
              prompt: cleanPrompt,
              correctAnswer: mainAnswer,
              acceptedKeywords: Array.from(new Set([mainAnswer, ...kw])),
              explanation:
                q.explanation?.trim() ||
                `Réponse attendue : « ${mainAnswer} » (p.${src.pageNumber}).`,
              generatedByAi: true,
            });
          } else if (
            q.type === "FILL_BLANK" &&
            q.sentenceWithBlank &&
            q.correctAnswer
          ) {
            seenPrompts.add(promptKey);
            anyAiUsed = true;
            const bank = [
              q.correctAnswer,
              ...(Array.isArray(q.distractors) ? q.distractors.slice(0, 3) : []),
            ];
            questions.push({
              id: `sq-${questions.length + 1}`,
              type: "FILL_BLANK",
              ueId: src.ueId,
              ueCode: src.ueCode,
              ueTitle: src.ueTitle,
              chapterTitle: src.chapterTitle,
              documentId: src.documentId,
              documentTitle: src.documentTitle,
              fileName: src.fileName,
              pageNumber: src.pageNumber,
              prompt: cleanPrompt,
              sentenceWithBlank: q.sentenceWithBlank,
              correctAnswer: q.correctAnswer,
              wordBank: bank,
              explanation:
                q.explanation?.trim() ||
                `Terme attendu : « ${q.correctAnswer} » (p.${src.pageNumber}).`,
              generatedByAi: true,
            });
          }
        }
      }
    }

    if (questions.length < targetCount && (anyAiUsed || !shouldStop?.())) {
      const sentencePool: Array<{ chunk: SourceChunk; sent: string }> = [];
      for (const c of orderedChunks) {
        const sents = splitSentences(c.content);
        if (sents.length > 0) {
          for (const s of sents) sentencePool.push({ chunk: c, sent: s });
        } else if (c.content.trim().length > 20) {
          sentencePool.push({ chunk: c, sent: c.content.trim().slice(0, 180) });
        }
      }
      if (sentencePool.length > 0) {
        let cursor = 0;
        const maxFallbackQuestions = anyAiUsed
          ? targetCount
          : Math.min(targetCount, Math.max(3, sentencePool.length));
        while (
          questions.length < maxFallbackQuestions &&
          cursor < targetCount * 2
        ) {
          const item = sentencePool[cursor % sentencePool.length];
          const other =
            sentencePool[(cursor + 1) % sentencePool.length] || item;
          cursor += 1;
          const fallbackPrompt = `D'après « ${item.chunk.documentTitle} » (${item.chunk.ueCode}, p.${item.chunk.pageNumber} · Q${questions.length + 1}), quelle proposition correspond exactement au cours ?`;
          const key = fallbackPrompt.toLowerCase().slice(0, 60);
          if (seenPrompts.has(key)) continue;
          seenPrompts.add(key);

          questions.push({
            id: `sq-${questions.length + 1}`,
            type: "QCU",
            ueId: item.chunk.ueId,
            ueCode: item.chunk.ueCode,
            ueTitle: item.chunk.ueTitle,
            chapterTitle: item.chunk.chapterTitle,
            documentId: item.chunk.documentId,
            documentTitle: item.chunk.documentTitle,
            fileName: item.chunk.fileName,
            pageNumber: item.chunk.pageNumber,
            prompt: fallbackPrompt,
            options: [
              item.sent,
              other.sent !== item.sent
                ? other.sent
                : `Affirmation inversée concernant ${item.chunk.chapterTitle}.`,
              `Cette notion n'est pas abordée dans ${item.chunk.chapterTitle}.`,
              `Assertion contradictoire avec la page ${item.chunk.pageNumber}.`,
            ],
            correctIndices: [0],
            explanation: `Extrait direct de ${item.chunk.fileName} (page ${item.chunk.pageNumber}).`,
            generatedByAi: false,
          });
        }
      }
    }

    onProgress?.(100, `${questions.length} questions générées`);
    return {
      title,
      usedAi: anyAiUsed,
      content: {
        kind: "QUIZ",
        questions: questions.slice(0, targetCount),
        sources,
      },
    };
  }

  // SUMMARY: Full-course structured summary (public 95%) vs targeted (private 5%)
  const title =
    params.title?.trim() ||
    (fullCourseMode
      ? `Fiche Cours Complet (95%) — ${chunks[0]?.documentTitle || defaultTopic}`
      : `Fiche Ciblée : ${defaultTopic}`);

  const segments = fullCourseMode
    ? partitionChunks(orderedChunks, 4)
    : [orderedChunks.slice(0, 10)];

  const sections: SummarySection[] = [];
  const overviewParts: string[] = [];
  const allConcepts: SummaryPayload["keyConcepts"] = [];
  const seenTerms = new Set<string>();
  const allPitfalls: string[] = [];
  const seenPitfalls = new Set<string>();
  let anyAiUsed = false;

  for (let sIdx = 0; sIdx < segments.length; sIdx += 1) {
    if (shouldStop?.()) break;

    const segChunks = segments[sIdx];
    const pageSpan = computePageRangeLabel(segChunks);
    onProgress?.(
      Math.round((sIdx / segments.length) * 100),
      fullCourseMode
        ? `Fiche complète (${pageSpan} · Partie ${sIdx + 1}/${segments.length})`
        : "Rédaction de la fiche ciblée..."
    );

    const segContext = formatChunksForPrompt(segChunks, 850, 12);
    const scopeInstruction = fullCourseMode
      ? `PARTIE ${sIdx + 1}/${segments.length} DU COURS (${pageSpan}) : Rédige un chapitre complet permettant à l'étudiant d'APPRENDRE INTÉGRALEMENT cette partie du polycopié sans avoir à rouvrir le PDF (mécanismes détaillés, définitions exactes, critères, seuils et repères).`
      : "Rédige une fiche pédagogique ciblée qui répond exactement à la difficulté ou question de l'étudiant.";

    const aiPart = await callOllamaJson<{
      sectionTitle?: string;
      summaryText?: string;
      keyPoints?: string[];
      keyConcepts?: Array<{
        term?: string;
        definition?: string;
        sourcePage?: number;
      }>;
      examPitfalls?: string[];
    }>(
      `Tu es Spix, professeur universitaire vétérinaire. ${scopeInstruction}
${customContextBlock}
Réponds STRICTEMENT en JSON :
{
  "sectionTitle": "Titre clair et structuré de cette partie",
  "summaryText": "Explication complète, fluide et pédagogique de la logique, des mécanismes, des rôles et des valeurs clés de cette partie (8 à 12 lignes).",
  "keyPoints": [
    "Point essentiel détaillé 1 (avec repère/valeur exacte si présent)",
    "Point essentiel détaillé 2",
    "Point essentiel détaillé 3",
    "Point essentiel détaillé 4",
    "Point essentiel détaillé 5"
  ],
  "keyConcepts": [
    { "term": "Concept clé", "definition": "Explication détaillée, mécanisme et repères...", "sourcePage": 1 }
  ],
  "examPitfalls": ["Piège fréquent ou confusion à éviter en partiel"]
}

EXTRAITS :
${segContext}`
    );

    const hasAiContent = Boolean(
      aiPart?.summaryText ||
        (aiPart?.keyConcepts && aiPart.keyConcepts.length > 0) ||
        (aiPart?.keyPoints && aiPart.keyPoints.length > 0)
    );

    if (hasAiContent) {
      anyAiUsed = true;
      const sectionTitle =
        aiPart?.sectionTitle?.trim() ||
        (fullCourseMode
          ? `Partie ${sIdx + 1} · ${segChunks[0]?.chapterTitle || "Cours"}`
          : defaultTopic);
      const summaryText =
        aiPart?.summaryText?.trim() ||
        segChunks
          .slice(0, 3)
          .map((c) => splitSentences(c.content)[0] || c.content.slice(0, 200))
          .join(" ");
      const keyPoints = Array.isArray(aiPart?.keyPoints)
        ? aiPart!.keyPoints.map((k) => String(k).trim()).filter(Boolean)
        : [];

      sections.push({
        title: sectionTitle,
        pageRange: pageSpan,
        content: summaryText,
        keyPoints,
      });
      overviewParts.push(
        fullCourseMode
          ? `[${sectionTitle} · ${pageSpan}] ${summaryText.split(/(?<=[.!?])\s+/)[0] || summaryText.slice(0, 180)}`
          : summaryText
      );

      for (let idx = 0; idx < (aiPart?.keyConcepts || []).length; idx += 1) {
        const kc = aiPart!.keyConcepts![idx];
        const term = (kc.term || "").trim();
        const def = (kc.definition || "").trim();
        if (!term || !def) continue;
        const tKey = term.toLowerCase();
        if (seenTerms.has(tKey)) continue;
        seenTerms.add(tKey);

        const src = resolveSourceChunkByPage(segChunks, kc.sourcePage, idx);
        allConcepts.push({
          term,
          definition: def,
          sourceLabel: `[${src.fileName.toUpperCase()} · P.${src.pageNumber}]`,
          documentId: src.documentId,
          pageNumber: src.pageNumber,
          ueId: src.ueId,
        });
      }

      for (const p of aiPart?.examPitfalls || []) {
        const cleanP = String(p).trim();
        if (!cleanP) continue;
        const pKey = cleanP.toLowerCase().slice(0, 50);
        if (!seenPitfalls.has(pKey)) {
          seenPitfalls.add(pKey);
          allPitfalls.push(cleanP);
        }
      }
    } else {
      const fallbackText = segChunks
        .slice(0, 3)
        .map((c) => splitSentences(c.content)[0] || c.content.slice(0, 200))
        .join(" ");
      sections.push({
        title: fullCourseMode
          ? `Partie ${sIdx + 1} · ${segChunks[0]?.chapterTitle || "Section"}`
          : defaultTopic,
        pageRange: pageSpan,
        content: fallbackText,
        keyPoints: segChunks
          .slice(0, 4)
          .map((c) => splitSentences(c.content)[0] || c.content.slice(0, 140))
          .filter(Boolean),
      });
      overviewParts.push(fallbackText);
    }
  }

  const maxConcepts = fullCourseMode ? 24 : 7;
  const maxPitfalls = fullCourseMode ? 12 : 5;

  if (allConcepts.length === 0) {
    for (const c of orderedChunks.slice(0, 4)) {
      allConcepts.push({
        term: c.chapterTitle,
        definition: splitSentences(c.content)[0] || c.content.slice(0, 180),
        sourceLabel: `[${c.fileName.toUpperCase()} · P.${c.pageNumber}]`,
        documentId: c.documentId,
        pageNumber: c.pageNumber,
        ueId: c.ueId,
      });
    }
  }

  if (allPitfalls.length === 0) {
    allPitfalls.push(
      "Vérifier les définitions exactes et les seuils numériques dans les polycopiés officiels.",
      "Relier chaque mécanisme aux schémas présentés en cours."
    );
  }

  onProgress?.(100, "Fiche de révision complète générée");
  return {
    title,
    usedAi: anyAiUsed,
    content: {
      kind: "SUMMARY",
      overview: overviewParts.join(" "),
      sections,
      keyConcepts: allConcepts.slice(0, maxConcepts),
      examPitfalls: allPitfalls.slice(0, maxPitfalls),
      sources,
    },
  };
}

export async function hasExistingPublicArtifact(
  documentId: string | null | undefined,
  kind: StudioArtifactKind
): Promise<boolean> {
  if (!documentId) return false;
  await ensureStudioSchema();
  const existing = await prisma.studyArtifact.findFirst({
    where: {
      documentId,
      kind,
      isPublic: true,
    },
    select: { id: true },
  });
  return Boolean(existing);
}

export interface IndexingQueueItem {
  documentId: string;
  chapterId: string;
  title: string;
  fileName: string;
  ueCode: string;
  chapterTitle: string;
  pageCount: number;
  totalChunks: number;
  embeddedChunks: number;
  status: "PENDING" | "RUNNING";
}

export interface AiQueueItem {
  id: string;
  documentId: string;
  chapterId: string;
  documentTitle: string;
  fileName: string;
  ueCode: string;
  chapterTitle: string;
  kind: "SUMMARY" | "FLASHCARDS" | "QUIZ";
  label: string;
  status: "PENDING" | "RUNNING";
}

export interface BackgroundQueueSnapshot {
  worker: {
    isRunning: boolean;
    stopRequested: boolean;
    mode: "IDLE" | "NIGHTLY_AUTO" | "ADMIN_MANUAL";
    currentPhase: "IDLE" | "INDEXING" | "AI_GENERATION";
    currentTaskLabel: string | null;
    currentItemProgressPercent: number;
    overallProgressPercent: number;
    completedItemsInRun: number;
    totalItemsInRun: number;
    startedAt: string | null;
    lastRunAt: string | null;
    lastRunSummary: string | null;
    nextNightlyWindowLabel: string;
  };
  eta: {
    indexingEtaSeconds: number;
    aiEtaSeconds: number;
    totalEtaSeconds: number;
    avgMsPerChunk: number;
    avgMsPerAiArtifact: number;
  };
  indexingQueue: IndexingQueueItem[];
  aiContentQueue: AiQueueItem[];
  counts: {
    totalDocuments: number;
    indexedDocuments: number;
    unindexedDocuments: number;
    pendingIndexingChunks: number;
    totalExpectedAiArtifacts: number;
    completedPublicAiArtifacts: number;
    pendingAiArtifacts: number;
  };
}

interface InternalBackgroundQueueState {
  isRunning: boolean;
  stopRequested: boolean;
  mode: "IDLE" | "NIGHTLY_AUTO" | "ADMIN_MANUAL";
  currentPhase: "IDLE" | "INDEXING" | "AI_GENERATION";
  currentDocumentId: string | null;
  currentAiKind: "SUMMARY" | "FLASHCARDS" | "QUIZ" | null;
  currentTaskLabel: string | null;
  currentItemProgressPercent: number;
  currentItemStartedAtMs: number | null;
  completedItemsInRun: number;
  totalItemsInRun: number;
  startedAt: string | null;
  lastRunAt: string | null;
  lastRunSummary: string | null;
  avgMsPerChunk: number;
  avgMsPerAiArtifact: number;
}

const globalForQueue = globalThis as typeof globalThis & {
  __araBackgroundQueueState?: InternalBackgroundQueueState;
};

function getQueueState(): InternalBackgroundQueueState {
  if (!globalForQueue.__araBackgroundQueueState) {
    globalForQueue.__araBackgroundQueueState = {
      isRunning: false,
      stopRequested: false,
      mode: "IDLE",
      currentPhase: "IDLE",
      currentDocumentId: null,
      currentAiKind: null,
      currentTaskLabel: null,
      currentItemProgressPercent: 0,
      currentItemStartedAtMs: null,
      completedItemsInRun: 0,
      totalItemsInRun: 0,
      startedAt: null,
      lastRunAt: null,
      lastRunSummary: null,
      avgMsPerChunk: 450,
      avgMsPerAiArtifact: 95000,
    };
  }
  return globalForQueue.__araBackgroundQueueState;
}

const TARGET_NIGHTLY_KINDS: Array<{
  kind: "SUMMARY" | "FLASHCARDS" | "QUIZ";
  label: string;
}> = [
  { kind: "SUMMARY", label: "Fiche de révision" },
  { kind: "FLASHCARDS", label: "Flashcards" },
  { kind: "QUIZ", label: "Quiz compréhension" },
];

export function requestStopBackgroundQueue(): void {
  const state = getQueueState();
  if (state.isRunning) {
    state.stopRequested = true;
  }
}

export async function getBackgroundQueueSnapshot(): Promise<BackgroundQueueSnapshot> {
  await ensureStudioSchema();
  const state = getQueueState();

  const [docs, chunkStatsRows, publicArtifactRows] = await Promise.all([
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
            id: true,
            title: true,
            ue: { select: { code: true } },
          },
        },
      },
    }),
    prisma.$queryRaw<
      Array<{ documentId: string; totalChunks: number; embeddedChunks: number }>
    >`
      SELECT "documentId",
             COUNT(*)::int AS "totalChunks",
             COUNT("embedding")::int AS "embeddedChunks"
      FROM "DocumentChunk"
      GROUP BY "documentId"
    `,
    prisma.studyArtifact.findMany({
      where: {
        documentId: { not: null },
        isPublic: true,
        kind: { in: ["SUMMARY", "FLASHCARDS", "QUIZ"] },
      },
      select: {
        documentId: true,
        kind: true,
      },
    }),
  ]);

  const chunkStatsMap = new Map<
    string,
    { totalChunks: number; embeddedChunks: number }
  >();
  for (const row of chunkStatsRows) {
    chunkStatsMap.set(row.documentId, {
      totalChunks: Number(row.totalChunks || 0),
      embeddedChunks: Number(row.embeddedChunks || 0),
    });
  }

  const publicSet = new Set<string>();
  for (const row of publicArtifactRows) {
    if (row.documentId) {
      publicSet.add(`${row.documentId}:${row.kind}`);
    }
  }

  const indexingQueue: IndexingQueueItem[] = [];
  const aiContentQueue: AiQueueItem[] = [];
  let indexedDocuments = 0;
  let pendingIndexingChunks = 0;
  let completedPublicAiArtifacts = 0;
  let totalExpectedAiArtifacts = 0;

  for (const doc of docs) {
    const cStats = chunkStatsMap.get(doc.id) || {
      totalChunks: 0,
      embeddedChunks: 0,
    };

    if (doc.isIndexed) {
      indexedDocuments += 1;
    } else {
      const effectiveTotalChunks =
        cStats.totalChunks > 0 ? cStats.totalChunks : Math.max(1, doc.pageCount);
      const remainingChunks =
        cStats.totalChunks > 0
          ? Math.max(0, cStats.totalChunks - cStats.embeddedChunks)
          : Math.max(1, doc.pageCount);
      pendingIndexingChunks += remainingChunks;

      const isThisRunning =
        state.isRunning &&
        state.currentPhase === "INDEXING" &&
        state.currentDocumentId === doc.id;

      indexingQueue.push({
        documentId: doc.id,
        chapterId: doc.chapter.id,
        title: doc.title,
        fileName: doc.fileName,
        ueCode: doc.chapter.ue.code,
        chapterTitle: doc.chapter.title,
        pageCount: doc.pageCount,
        totalChunks: effectiveTotalChunks,
        embeddedChunks: cStats.embeddedChunks,
        status: isThisRunning ? "RUNNING" : "PENDING",
      });
    }

    const canGenerateAi = cStats.totalChunks > 0 || !doc.isIndexed;
    if (canGenerateAi) {
      for (const spec of TARGET_NIGHTLY_KINDS) {
        totalExpectedAiArtifacts += 1;
        if (publicSet.has(`${doc.id}:${spec.kind}`)) {
          completedPublicAiArtifacts += 1;
        } else {
          const isThisRunning =
            state.isRunning &&
            state.currentPhase === "AI_GENERATION" &&
            state.currentDocumentId === doc.id &&
            state.currentAiKind === spec.kind;

          aiContentQueue.push({
            id: `${doc.id}:${spec.kind}`,
            documentId: doc.id,
            chapterId: doc.chapter.id,
            documentTitle: doc.title,
            fileName: doc.fileName,
            ueCode: doc.chapter.ue.code,
            chapterTitle: doc.chapter.title,
            kind: spec.kind,
            label: spec.label,
            status: isThisRunning ? "RUNNING" : "PENDING",
          });
        }
      }
    }
  }

  let currentItemProgressPercent = state.currentItemProgressPercent;
  if (
    state.isRunning &&
    state.currentPhase === "AI_GENERATION" &&
    state.currentItemStartedAtMs
  ) {
    const elapsed = Math.max(0, Date.now() - state.currentItemStartedAtMs);
    currentItemProgressPercent = Math.max(
      state.currentItemProgressPercent,
      8,
      Math.min(92, Math.round((elapsed / Math.max(5000, state.avgMsPerAiArtifact)) * 90))
    );
  }

  const indexingEtaSeconds = Math.ceil(
    (pendingIndexingChunks * state.avgMsPerChunk) / 1000
  );

  let aiRemainingMs = aiContentQueue.length * state.avgMsPerAiArtifact;
  if (
    state.isRunning &&
    state.currentPhase === "AI_GENERATION" &&
    state.currentItemStartedAtMs &&
    aiContentQueue.length > 0
  ) {
    const elapsedCurrent = Math.max(0, Date.now() - state.currentItemStartedAtMs);
    const savedOnCurrent = Math.min(state.avgMsPerAiArtifact * 0.85, elapsedCurrent);
    aiRemainingMs = Math.max(2000, aiRemainingMs - savedOnCurrent);
  }
  const aiEtaSeconds = Math.ceil(aiRemainingMs / 1000);
  const totalEtaSeconds = indexingEtaSeconds + aiEtaSeconds;

  let overallProgressPercent = 0;
  if (state.isRunning && state.totalItemsInRun > 0) {
    overallProgressPercent = Math.min(
      99,
      Math.round(
        ((state.completedItemsInRun + currentItemProgressPercent / 100) /
          state.totalItemsInRun) *
          100
      )
    );
  } else {
    const totalTasksAll = docs.length + totalExpectedAiArtifacts;
    const doneTasksAll = indexedDocuments + completedPublicAiArtifacts;
    overallProgressPercent =
      totalTasksAll > 0 ? Math.round((doneTasksAll / totalTasksAll) * 100) : 100;
  }

  const nowHour = new Date().getHours();
  const nextNightlyWindowLabel =
    nowHour >= 0 && nowHour < 7
      ? "FENÊTRE HEURES CREUSES ACTIVE (00H00–07H00)"
      : "PROCHAINE FENÊTRE AUTO : 00H00–07H00";

  return {
    worker: {
      isRunning: state.isRunning,
      stopRequested: state.stopRequested,
      mode: state.mode,
      currentPhase: state.currentPhase,
      currentTaskLabel: state.currentTaskLabel,
      currentItemProgressPercent,
      overallProgressPercent,
      completedItemsInRun: state.completedItemsInRun,
      totalItemsInRun: state.totalItemsInRun,
      startedAt: state.startedAt,
      lastRunAt: state.lastRunAt,
      lastRunSummary: state.lastRunSummary,
      nextNightlyWindowLabel,
    },
    eta: {
      indexingEtaSeconds,
      aiEtaSeconds,
      totalEtaSeconds,
      avgMsPerChunk: Math.round(state.avgMsPerChunk),
      avgMsPerAiArtifact: Math.round(state.avgMsPerAiArtifact),
    },
    indexingQueue,
    aiContentQueue,
    counts: {
      totalDocuments: docs.length,
      indexedDocuments,
      unindexedDocuments: indexingQueue.length,
      pendingIndexingChunks,
      totalExpectedAiArtifacts,
      completedPublicAiArtifacts,
      pendingAiArtifacts: aiContentQueue.length,
    },
  };
}

function isWithinOffPeakWindow(): boolean {
  const h = new Date().getHours();
  return h >= 0 && h < 7;
}

export async function runNightlyOffPeakStudyGeneration(options?: {
  force?: boolean;
  maxItems?: number;
  mode?: "NIGHTLY_AUTO" | "ADMIN_MANUAL";
  scope?: "ALL" | "INDEXING_ONLY" | "AI_ONLY";
  chapterId?: string;
  documentId?: string;
}): Promise<{
  skipped: boolean;
  reason?: string;
  indexedCount: number;
  generatedCount: number;
}> {
  const state = getQueueState();
  if (state.isRunning) {
    return {
      skipped: true,
      reason: "already-running",
      indexedCount: 0,
      generatedCount: 0,
    };
  }

  const mode = options?.mode || (options?.force ? "ADMIN_MANUAL" : "NIGHTLY_AUTO");
  const scope = options?.scope || "ALL";
  const targetChapterId = options?.chapterId?.trim() || undefined;
  const targetDocumentId = options?.documentId?.trim() || undefined;

  if (!options?.force && !isWithinOffPeakWindow()) {
    return {
      skipped: true,
      reason: "outside-off-peak-hours",
      indexedCount: 0,
      generatedCount: 0,
    };
  }

  const health = await checkOllamaHealth();
  if (!health.online) {
    return {
      skipped: true,
      reason: "ollama-offline",
      indexedCount: 0,
      generatedCount: 0,
    };
  }

  await ensureStudioSchema();
  const initialSnapshot = await getBackgroundQueueSnapshot();

  const matchesTarget = (item: { chapterId: string; documentId: string }) =>
    (!targetChapterId || item.chapterId === targetChapterId) &&
    (!targetDocumentId || item.documentId === targetDocumentId);

  const totalIdxPlanned =
    scope === "ALL" || scope === "INDEXING_ONLY"
      ? initialSnapshot.indexingQueue.filter(matchesTarget).length
      : 0;
  const totalAiPlanned =
    scope === "ALL" || scope === "AI_ONLY"
      ? initialSnapshot.aiContentQueue.filter(matchesTarget).length
      : 0;

  if (totalIdxPlanned === 0 && totalAiPlanned === 0) {
    state.lastRunAt = new Date().toISOString();
    state.lastRunSummary = "Aucun document ni contenu IA en attente.";
    return {
      skipped: false,
      reason: "nothing-pending",
      indexedCount: 0,
      generatedCount: 0,
    };
  }

  state.isRunning = true;
  state.stopRequested = false;
  state.mode = mode;
  state.currentPhase = "IDLE";
  state.currentDocumentId = null;
  state.currentAiKind = null;
  state.currentTaskLabel = "Initialisation de la file...";
  state.currentItemProgressPercent = 0;
  state.currentItemStartedAtMs = Date.now();
  state.completedItemsInRun = 0;
  state.totalItemsInRun = totalIdxPlanned + totalAiPlanned;
  state.startedAt = new Date().toISOString();

  let indexedCount = 0;
  let generatedCount = 0;
  const maxItems = Math.max(1, options?.maxItems || 100);

  const shouldAbort = () =>
    state.stopRequested || (mode === "NIGHTLY_AUTO" && !isWithinOffPeakWindow());

  try {
    // Phase 1: Index unindexed documents sequentially
    if (scope === "ALL" || scope === "INDEXING_ONLY") {
      const unindexedDocs = await prisma.document.findMany({
        where: {
          isIndexed: false,
          ...(targetChapterId ? { chapterId: targetChapterId } : {}),
          ...(targetDocumentId ? { id: targetDocumentId } : {}),
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          title: true,
          localPath: true,
          _count: { select: { chunks: true } },
        },
      });

      for (const doc of unindexedDocs) {
        if (shouldAbort()) break;

        state.currentPhase = "INDEXING";
        state.currentDocumentId = doc.id;
        state.currentAiKind = null;
        state.currentTaskLabel = `Indexation RAG : ${doc.title}`;
        state.currentItemProgressPercent = 0;
        state.currentItemStartedAtMs = Date.now();

        try {
          if (doc._count.chunks === 0) {
            const resolvedPath = resolveDocumentFilePath(doc.localPath);
            const buffer = await fsp.readFile(resolvedPath);
            const extracted = await extractPdfPages(buffer);

            await prisma.document.update({
              where: { id: doc.id },
              data: { pageCount: extracted.pageCount },
            });

            const stored = await storeDocumentChunksUnindexed(
              doc.id,
              extracted.pages
            );
            if (stored.chunkCount === 0) {
              state.completedItemsInRun += 1;
              continue;
            }
          }

          const res = await embedExistingDocumentChunks(doc.id, {
            shouldStop: shouldAbort,
            onProgress: (done, total, chunkMs) => {
              state.currentItemProgressPercent = Math.round(
                (done / Math.max(1, total)) * 100
              );
              if (chunkMs > 20 && chunkMs < 60000) {
                state.avgMsPerChunk = Math.round(
                  state.avgMsPerChunk * 0.75 + chunkMs * 0.25
                );
              }
            },
          });

          if (res.indexed) {
            indexedCount += 1;
          }
          if (!res.stopped) {
            state.completedItemsInRun += 1;
          }
        } catch (err) {
          console.error(`[NightlyIndex] Failed for doc ${doc.id}:`, err);
          state.completedItemsInRun += 1;
        }
      }
    }

    // Phase 2: Sequential solo AI generation for missing public Studio artifacts
    if ((scope === "ALL" || scope === "AI_ONLY") && !shouldAbort()) {
      const docs = await prisma.document.findMany({
        where: {
          chunks: { some: {} },
          ...(targetChapterId ? { chapterId: targetChapterId } : {}),
          ...(targetDocumentId ? { id: targetDocumentId } : {}),
        },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          title: true,
          authorId: true,
          chapter: { select: { ueId: true } },
        },
      });

      for (const doc of docs) {
        if (shouldAbort() || generatedCount >= maxItems) break;

        for (const spec of TARGET_NIGHTLY_KINDS) {
          if (shouldAbort() || generatedCount >= maxItems) break;

          const alreadyPublic = await hasExistingPublicArtifact(
            doc.id,
            spec.kind
          );
          if (alreadyPublic) {
            continue;
          }

          const chunks = await gatherStudioSourceChunks({
            ueId: doc.chapter.ueId,
            documentIds: [doc.id],
            fullDocument: true,
          });
          if (chunks.length === 0) {
            state.completedItemsInRun += 1;
            continue;
          }

          state.currentPhase = "AI_GENERATION";
          state.currentDocumentId = doc.id;
          state.currentAiKind = spec.kind;
          state.currentTaskLabel = `${spec.label} (95%) : ${doc.title}`;
          state.currentItemProgressPercent = 5;
          state.currentItemStartedAtMs = Date.now();

          const t0 = Date.now();
          const generated = await generateStudioArtifact({
            kind: spec.kind,
            chunks,
            isPublic: true,
            title: `${spec.label} — ${doc.title}`,
            shouldStop: shouldAbort,
            onProgress: (pct, detail) => {
              state.currentItemProgressPercent = Math.max(
                state.currentItemProgressPercent,
                Math.min(99, pct)
              );
              state.currentTaskLabel = `${detail} — ${doc.title}`;
            },
          });
          const elapsedMs = Date.now() - t0;

          if (generated.usedAi) {
            if (elapsedMs > 2000 && elapsedMs < 900000) {
              state.avgMsPerAiArtifact = Math.round(
                state.avgMsPerAiArtifact * 0.7 + elapsedMs * 0.3
              );
            }

            await prisma.studyArtifact.create({
              data: {
                userId: doc.authorId,
                ueId: doc.chapter.ueId,
                documentId: doc.id,
                kind: spec.kind,
                title: generated.title,
                contentJson: JSON.stringify(generated.content),
                isPublic: true,
              },
            });
            generatedCount += 1;
          }

          state.completedItemsInRun += 1;
        }
      }
    }

    const stoppedReason = state.stopRequested ? " (arrêt demandé)" : "";
    state.lastRunAt = new Date().toISOString();
    state.lastRunSummary = `${indexedCount} PDF indexé(s) · ${generatedCount} contenu(x) IA généré(s)${stoppedReason}.`;
    return {
      skipped: false,
      indexedCount,
      generatedCount,
    };
  } catch (err) {
    console.error("[NightlyStudio] Error during off-peak generation:", err);
    state.lastRunAt = new Date().toISOString();
    state.lastRunSummary = `Interrompu avec erreur (${indexedCount} indexés, ${generatedCount} IA).`;
    return {
      skipped: false,
      reason: "error",
      indexedCount,
      generatedCount,
    };
  } finally {
    state.isRunning = false;
    state.stopRequested = false;
    state.mode = "IDLE";
    state.currentPhase = "IDLE";
    state.currentDocumentId = null;
    state.currentAiKind = null;
    state.currentTaskLabel = null;
    state.currentItemProgressPercent = 0;
    state.currentItemStartedAtMs = null;
  }
}
