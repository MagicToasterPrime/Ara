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
  getParisHour,
  storeDocumentChunksUnindexed,
  withOllamaLock,
} from "@/lib/ollama";
import { extractPdfPages } from "@/lib/pdf";
import {
  buildFactFlashcardsFromChunks,
  buildFactQuestionsFromChunks,
  cleanChunkTextForAi,
  extractCourseFacts,
  isLowQualityExcerptQuestion,
  parseOllamaJsonWithRecovery,
  selectHighValueText,
  shuffleOptionsWithIndices,
  type RevisionQuestion,
} from "@/lib/revisions";
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

export interface SummaryCallout {
  type?: "DEFINITION" | "RULE" | "ALERT" | "KEY_DATE";
  icon?: string;
  title: string;
  text?: string;
  items?: string[];
}

export interface SummaryBullet {
  lead?: string;
  text: string;
  subItems?: string[];
}

export interface SummaryTable {
  title?: string;
  headers: string[];
  rows: string[][];
}

export interface SummarySubSection {
  icon?: string;
  title: string;
  intro?: string;
  callouts?: SummaryCallout[];
  bullets?: SummaryBullet[];
  table?: SummaryTable | null;
}

export interface SummarySection {
  title: string;
  pageRange: string;
  content: string;
  keyPoints: string[];
  subsections?: SummarySubSection[];
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

  const targetLimit = fullDocument ? 84 : 14;
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

async function callOllamaJson<T>(
  prompt: string,
  options?: {
    timeoutMs?: number;
    arrayKeys?: string[];
    numPredict?: number;
  }
): Promise<T | null> {
  const timeoutMs = options?.timeoutMs ?? 150000;
  const arrayKeys = options?.arrayKeys ?? [];
  const numPredict = options?.numPredict ?? 2600;

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
            temperature: 0.25,
            num_ctx: 8192,
            num_predict: numPredict,
          },
        }),
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const data = (await res.json()) as { response?: string };
      if (!data.response) return null;
      return parseOllamaJsonWithRecovery<T>(data.response, arrayKeys);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  });
}

function splitSentences(text: string): string[] {
  return cleanChunkTextForAi(text)
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25);
}

function stripOptionLetterPrefix(opt: string): string {
  return opt.replace(/^[A-D]\s*[.)\]:-]\s+/i, "").trim();
}

function avoidHintFromList(avoidList: string): string {
  if (!avoidList.trim()) return "";
  return `\nÉVITE ABSOLUMENT de répéter les questions/notions déjà générées :\n${avoidList.slice(
    0,
    500
  )}\n`;
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
  maxCharsPerChunk = 540,
  maxChunks = 6
): string {
  return segmentChunks
    .slice(0, maxChunks)
    .map(
      (c) =>
        `[${c.fileName} · P.${c.pageNumber}] (${c.ueCode} - ${c.chapterTitle})\n${selectHighValueText(
          c.content,
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
    visualContextNote + formatChunksForPrompt(orderedChunks, 560, 7);

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
      : [orderedChunks.slice(0, 8)];

    const cards: FlashcardItem[] = [];
    const seenFronts = new Set<string>();
    let anyAiUsed = false;

    const runFlashcardPass = async (
      segChunks: SourceChunk[],
      passLabel: string,
      desiredCount: number,
      avoidHint = ""
    ) => {
      const segContext = formatChunksForPrompt(segChunks, 560, 8);
      const aiCards = await callOllamaJson<{
        cards?: Array<{
          front?: string;
          back?: string;
          tag?: string;
          sourcePage?: number;
        }>;
      }>(
        `Tu es un créateur de flashcards pédagogiques de niveau NotebookLM pour des étudiants vétérinaires d'Oniris.
Génère exactement ${desiredCount} flashcards de RÉVISION ACTIVE basées sur les VALEURS, DÉFINITIONS, MÉCANISMES et CRITÈRES extraits de ces extraits.
${passLabel}
${customContextBlock}${avoidHint}
RÈGLES STRICTES :
1. RECTO ("front") : Une QUESTION DIRECTE, COURTE et AUTONOME en une seule phrase (10 à 22 mots max), testant une valeur précise (taille, %, seuil, date, effectif), un mécanisme, un rôle ou une distinction.
   EXEMPLE MODÈLE : "Quelle est la plage de taille caractéristique d'un érythrocyte chez les mammifères ?"
   INTERDIT : "Notion clé page X : que faut-il retenir ?" ou recopier une phrase du texte.
2. VERSO ("back") : Réponse exacte, nette et concise en 1 à 2 phrases. Mets la valeur ou le terme clé en gras au début (ex : "**6 à 8 µm** de diamètre en moyenne (cellule biconcave anucléée chez les mammifères).").
3. Indique un "tag" court (ex : "VALEUR CLÉ", "DÉFINITION", "MÉCANISME", "ANATOMIE", "CLINIQUE") et "sourcePage".

Réponds STRICTEMENT en JSON :
{
  "cards": [
    {
      "front": "Question courte et directe sur une valeur, notion ou mécanisme ?",
      "back": "**Réponse clé** : explication concise et précise issue du cours.",
      "tag": "VALEUR CLÉ",
      "sourcePage": 1
    }
  ]
}

EXTRAITS :
${segContext}`,
        { arrayKeys: ["cards"], numPredict: 2400 }
      );

      if (
        aiCards?.cards &&
        Array.isArray(aiCards.cards) &&
        aiCards.cards.length > 0
      ) {
        anyAiUsed = true;
        for (let idx = 0; idx < aiCards.cards.length; idx += 1) {
          if (cards.length >= targetCount) break;
          const c = aiCards.cards[idx];
          if (!c.front || !c.back) continue;
          const cleanFront = String(c.front).trim();
          const cleanBack = String(c.back).trim();
          if (
            cleanFront.length < 10 ||
            cleanBack.length < 4 ||
            isLowQualityExcerptQuestion(cleanFront)
          ) {
            continue;
          }
          const normKey = cleanFront.toLowerCase().slice(0, 60);
          if (seenFronts.has(normKey)) continue;
          seenFronts.add(normKey);

          const src = resolveSourceChunkByPage(segChunks, c.sourcePage, idx);
          cards.push({
            id: `fc-${cards.length + 1}-${crypto.randomUUID().slice(0, 4)}`,
            front: cleanFront,
            back: cleanBack,
            tag: String(c.tag || src?.ueCode || "NOTION CLÉ").trim(),
            documentId: src?.documentId || "",
            fileName: src?.fileName || "document.pdf",
            pageNumber: src?.pageNumber || 1,
            ueId: src?.ueId || "",
          });
        }
      }
    };

    for (let sIdx = 0; sIdx < segments.length; sIdx += 1) {
      if (shouldStop?.() || cards.length >= targetCount) break;

      const segChunks = segments[sIdx];
      const pageSpan = computePageRangeLabel(segChunks);
      onProgress?.(
        Math.round((sIdx / segments.length) * 100),
        `Flashcards (${pageSpan} · Lot ${sIdx + 1}/${segments.length})`
      );

      const scopeHint = fullCourseMode
        ? `PARTIE ${sIdx + 1}/${segments.length} DU COURS (${pageSpan}) : extrais toutes les valeurs, définitions et mécanismes de ces pages (objectif global : 95% du cours sur les ${segments.length} lots).`
        : "Focus ciblé et exigeant sur la notion demandée par l'étudiant.";

      await runFlashcardPass(
        segChunks,
        scopeHint,
        fullCourseMode ? 10 : 10
      );
    }

    // AI top-up pass if Ollama is responsive and slightly below targetCount
    if (anyAiUsed && cards.length < targetCount && !shouldStop?.()) {
      for (let extra = 0; extra < 2 && cards.length < targetCount; extra += 1) {
        const deficit = Math.min(10, targetCount - cards.length);
        const topUpChunks = segments[extra % segments.length] || orderedChunks;
        const avoidList = cards
          .slice(-8)
          .map((c) => c.front)
          .join(" | ");
        await runFlashcardPass(
          topUpChunks,
          `COMPLÉMENT (${deficit} nouvelles flashcards distinctes) : explore d'autres détails, chiffres ou exemples non encore traités.`,
          deficit,
          avoidHintFromList(avoidList)
        );
      }
    }

    // Emergency factual extractor fallback only if still incomplete (never raw poly chunks)
    if (cards.length < targetCount && (anyAiUsed || !shouldStop?.())) {
      const factCards = buildFactFlashcardsFromChunks(
        orderedChunks,
        targetCount - cards.length,
        seenFronts
      );
      for (const fc of factCards) {
        if (cards.length >= targetCount) break;
        cards.push({
          id: `fc-${cards.length + 1}-${crypto.randomUUID().slice(0, 4)}`,
          ...fc,
        });
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
      : [orderedChunks.slice(0, 8)];

    const questions: RevisionQuestion[] = [];
    const seenPrompts = new Set<string>();
    let anyAiUsed = false;

    const runQuizPass = async (
      segChunks: SourceChunk[],
      passLabel: string,
      batchSize: number,
      avoidHint = ""
    ) => {
      const segContext = formatChunksForPrompt(segChunks, 560, 8);
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
        `Tu es un concepteur d'examens de niveau NotebookLM pour étudiants vétérinaires d'Oniris.
Génère un QUIZ ORIGINAL de ${batchSize} questions précises testant les VALEURS, SEUILS, DÉFINITIONS et MÉCANISMES extraits du cours ci-dessous.
${passLabel}
${customContextBlock}${avoidHint}
RÈGLES ABSOLUES (NON NÉGOCIABLES) :
1. INTERDIT de recopier des phrases du polycopié en options ou de demander « quelle phrase correspond au cours ».
2. QCU (majoritaire) : pose une question directe et précise (ex : "Quel pourcentage approximatif de thymocytes subit la mort par apoptose lors du processus de sélection dans la corticale thymique ?").
   Les 4 options ("options") DOIVENT être COURTES (1 à 8 mots maximum, homogènes entre elles), SANS préfixe "A./B.", comme : ["Moins de 5%", "Environ 10 à 15%", "Plus de 90%", "Exactement 50%"].
3. QCM : question à 2 ou 3 bonnes réponses, avec 4 options courtes et claires (1 à 10 mots max par option).
4. QROC : question ouverte courte dont la réponse attendue tient en 1 à 4 mots exacts (un terme, chiffre ou mécanisme).
5. Varie la position de la bonne réponse et rédige une "explanation" concise.

Réponds STRICTEMENT en JSON :
{
  "questions": [
    {
      "type": "QCU",
      "prompt": "Quel pourcentage approximatif de thymocytes subit l'apoptose dans la corticale thymique ?",
      "options": ["Moins de 5%", "Environ 10 à 15%", "Plus de 90%", "Exactement 50%"],
      "correctIndices": [2],
      "explanation": "Plus de 90 % des thymocytes sont éliminés lors de la sélection positive/négative.",
      "sourcePage": 2
    },
    {
      "type": "QCM",
      "prompt": "Parmi ces éléments concernant ce mécanisme, lesquels sont exacts ?",
      "options": ["Option courte 1", "Option courte 2", "Option courte 3", "Option courte 4"],
      "correctIndices": [0, 2],
      "explanation": "Justification concise.",
      "sourcePage": 4
    },
    {
      "type": "QROC",
      "prompt": "Quel terme désigne l'agent ou le concept clé de cette étape ?",
      "correctAnswer": "Réponse courte",
      "acceptedKeywords": ["motcle1", "synonyme"],
      "explanation": "Justification concise.",
      "sourcePage": 5
    }
  ]
}

EXTRAITS :
${segContext}`,
        { arrayKeys: ["questions"], numPredict: 2400 }
      );

      if (
        aiQuiz?.questions &&
        Array.isArray(aiQuiz.questions) &&
        aiQuiz.questions.length > 0
      ) {
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
            const cleanOpts = q.options.map((o) =>
              stripOptionLetterPrefix(String(o))
            );
            if (isLowQualityExcerptQuestion(cleanPrompt, cleanOpts)) continue;

            const validIndices = Array.from(
              new Set(
                q.correctIndices.filter(
                  (i) => typeof i === "number" && i >= 0 && i < 4
                )
              )
            ).sort((a, b) => a - b);

            if (validIndices.length > 0) {
              const targetIndices =
                q.type === "QCU" ? [validIndices[0]] : validIndices;
              const shuffled = shuffleOptionsWithIndices(cleanOpts, targetIndices);
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
                options: shuffled.options,
                correctIndices: shuffled.correctIndices,
                explanation:
                  q.explanation?.trim() ||
                  `Source : ${src.documentTitle} (p.${src.pageNumber}).`,
                generatedByAi: true,
              });
            }
          } else if (
            q.type === "QROC" &&
            typeof q.correctAnswer === "string" &&
            q.correctAnswer.trim().length > 0 &&
            !isLowQualityExcerptQuestion(cleanPrompt)
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
            q.correctAnswer &&
            !isLowQualityExcerptQuestion(cleanPrompt)
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
    };

    for (let sIdx = 0; sIdx < segments.length; sIdx += 1) {
      if (shouldStop?.() || questions.length >= targetCount) break;

      const segChunks = segments[sIdx];
      const pageSpan = computePageRangeLabel(segChunks);
      onProgress?.(
        Math.round((sIdx / segments.length) * 100),
        `Quiz (${pageSpan} · Lot ${sIdx + 1}/${segments.length})`
      );

      const batchSize = fullCourseMode ? 5 : 6;
      const scopeHint = fullCourseMode
        ? `PARTIE ${sIdx + 1}/${segments.length} DU COURS (${pageSpan}) : interroge les notions, chiffres et mécanismes clés de ces pages pour couvrir 95% du cours sur les ${segments.length} lots.`
        : "Focus ciblé et exigeant sur ce que l'étudiant cherche à comprendre.";

      await runQuizPass(segChunks, scopeHint, batchSize);
    }

    // AI top-up pass if Ollama is responsive and slightly below targetCount
    if (anyAiUsed && questions.length < targetCount && !shouldStop?.()) {
      for (
        let extra = 0;
        extra < 2 && questions.length < targetCount;
        extra += 1
      ) {
        const deficit = Math.min(6, targetCount - questions.length);
        const topUpChunks = segments[extra % segments.length] || orderedChunks;
        const avoidList = questions
          .slice(-6)
          .map((q) => q.prompt)
          .join(" | ");
        await runQuizPass(
          topUpChunks,
          `COMPLÉMENT (${deficit} nouvelles questions distinctes) : interroge d'autres valeurs, cas ou notions non encore posés.`,
          deficit,
          avoidHintFromList(avoidList)
        );
      }
    }

    // Emergency factual/value fallback (zero raw poly paragraph copying)
    if (questions.length < targetCount && (anyAiUsed || !shouldStop?.())) {
      const factQuestions = buildFactQuestionsFromChunks(
        orderedChunks,
        targetCount - questions.length,
        seenPrompts
      );
      for (const fq of factQuestions) {
        if (questions.length >= targetCount) break;
        questions.push({
          ...fq,
          id: `sq-${questions.length + 1}`,
        });
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

  // SUMMARY: Full-course structured "Fiche de Révision Ultime" (public 95%) vs targeted (private 5%)
  const title =
    params.title?.trim() ||
    (fullCourseMode
      ? `Fiche de Révision Ultime — ${chunks[0]?.documentTitle || defaultTopic}`
      : `Fiche Ciblée : ${defaultTopic}`);

  const segments = fullCourseMode
    ? partitionChunks(orderedChunks, orderedChunks.length >= 36 ? 6 : 4)
    : [orderedChunks.slice(0, 8)];

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
        ? `Fiche Ultime (${pageSpan} · Partie ${sIdx + 1}/${segments.length})`
        : "Rédaction de la fiche ciblée..."
    );

    const segContext = formatChunksForPrompt(segChunks, 620, 9);
    const scopeInstruction = fullCourseMode
      ? `PARTIE ${sIdx + 1}/${segments.length} DU COURS (${pageSpan}) : Rédige un chapitre ultra-structuré type « Fiche de Révision Ultime » permettant à un étudiant d'APPRENDRE INTÉGRALEMENT cette partie (définitions/étymologies, dates/valeurs clés, encadrés Règle d'or, puces **Terme** : explication détaillée, et tableaux comparatifs dès qu'il y a plusieurs espèces/catégories/étapes).`
      : "Rédige une fiche pédagogique structurée type « Fiche de Révision Ultime » qui répond exactement à la difficulté ou question de l'étudiant.";

    const aiPart = await callOllamaJson<{
      sectionTitle?: string;
      summaryText?: string;
      subsections?: Array<{
        icon?: string;
        title?: string;
        intro?: string;
        callouts?: Array<{
          type?: "DEFINITION" | "RULE" | "ALERT" | "KEY_DATE";
          icon?: string;
          title?: string;
          text?: string;
          items?: string[];
        }>;
        bullets?: Array<{
          lead?: string;
          text?: string;
          subItems?: string[];
        }>;
        table?: {
          title?: string;
          headers?: string[];
          rows?: string[][];
        } | null;
      }>;
      keyPoints?: string[];
      keyConcepts?: Array<{
        term?: string;
        definition?: string;
        sourcePage?: number;
      }>;
      examPitfalls?: string[];
    }>(
      `Tu es Spix, professeur universitaire vétérinaire à Oniris. ${scopeInstruction}
${customContextBlock}
STRUCTURE ATTENDUE (« Fiche de Révision Ultime » — rédigée pour réviser vite et en profondeur) :
- Utilise des titres de sous-parties thématiques avec icône ("📜", "🌾", "🏫", "🎯", "📊", "💼", "⚠️", "🏷️", "🦠", "🆔", "🔬").
- Mets en avant les définitions, dates clés et règles absolues dans des encadrés "callouts" (icônes "💡", "⚠️", "🚨").
- Dans "bullets", écris **lead** (le terme/concept en 1 à 4 mots) et **text** (explication claire, précise, avec **gras** sur les mots-clés/valeurs et exemples concrets).
- Inclus un "table" dès que l'extrait présente un lexique, des espèces, des stades ou des données comparables (sinon mets null).

Réponds STRICTEMENT en JSON :
{
  "sectionTitle": "Titre clair de ce grand chapitre",
  "summaryText": "Synthèse fluide et pédagogique de cette partie (3 à 5 phrases).",
  "subsections": [
    {
      "icon": "📜",
      "title": "Titre de la sous-partie",
      "intro": "Phrase d'accroche éventuelle.",
      "callouts": [
        {
          "type": "DEFINITION",
          "icon": "💡",
          "title": "Définition & Point Clé à retenir",
          "text": "Explication claire avec les **termes importants** en gras.",
          "items": []
        }
      ],
      "bullets": [
        {
          "lead": "Concept ou Catégorie",
          "text": "Explication précise avec **valeurs exactes** et exemples.",
          "subItems": ["Sous-détail éventuel"]
        }
      ],
      "table": {
        "title": "Tableau comparatif éventuel",
        "headers": ["Colonne 1", "Colonne 2", "Colonne 3"],
        "rows": [["Donnée 1", "Donnée 2", "Donnée 3"]]
      }
    }
  ],
  "keyPoints": [
    "Point essentiel 1 avec repère/valeur exacte",
    "Point essentiel 2"
  ],
  "keyConcepts": [
    { "term": "Concept clé", "definition": "Explication précise et mécanisme...", "sourcePage": 1 }
  ],
  "examPitfalls": ["Piège fréquent ou confusion à éviter en partiel"]
}

EXTRAITS :
${segContext}`,
      { arrayKeys: ["subsections"], numPredict: 3000 }
    );

    const normalizedSubsections: SummarySubSection[] = [];
    if (Array.isArray(aiPart?.subsections)) {
      for (const rawSub of aiPart.subsections) {
        if (!rawSub?.title) continue;
        const callouts: SummaryCallout[] = Array.isArray(rawSub.callouts)
          ? rawSub.callouts
              .filter((c) => Boolean(c?.title && (c.text || (c.items && c.items.length > 0))))
              .map((c) => ({
                type: c.type || "DEFINITION",
                icon:
                  c.icon ||
                  (c.type === "ALERT"
                    ? "🚨"
                    : c.type === "KEY_DATE" || c.type === "RULE"
                    ? "⚠️"
                    : "💡"),
                title: String(c.title).trim(),
                text: c.text ? String(c.text).trim() : undefined,
                items: Array.isArray(c.items)
                  ? c.items.map((x) => String(x).trim()).filter(Boolean)
                  : undefined,
              }))
          : [];

        const bullets: SummaryBullet[] = Array.isArray(rawSub.bullets)
          ? rawSub.bullets
              .filter((b) => Boolean(b?.text || b?.lead))
              .map((b) => ({
                lead: b.lead ? String(b.lead).trim() : undefined,
                text: String(b.text || "").trim(),
                subItems: Array.isArray(b.subItems)
                  ? b.subItems.map((s) => String(s).trim()).filter(Boolean)
                  : undefined,
              }))
          : [];

        let table: SummaryTable | null = null;
        if (
          rawSub.table &&
          Array.isArray(rawSub.table.headers) &&
          rawSub.table.headers.length >= 2 &&
          Array.isArray(rawSub.table.rows) &&
          rawSub.table.rows.length > 0
        ) {
          table = {
            title: rawSub.table.title
              ? String(rawSub.table.title).trim()
              : undefined,
            headers: rawSub.table.headers.map((h) => String(h).trim()),
            rows: rawSub.table.rows.map((r) =>
              Array.isArray(r) ? r.map((cell) => String(cell).trim()) : []
            ),
          };
        }

        if (callouts.length > 0 || bullets.length > 0 || table || rawSub.intro) {
          normalizedSubsections.push({
            icon: rawSub.icon ? String(rawSub.icon).trim() : "📌",
            title: String(rawSub.title).trim(),
            intro: rawSub.intro ? String(rawSub.intro).trim() : undefined,
            callouts,
            bullets,
            table,
          });
        }
      }
    }

    const hasAiContent = Boolean(
      normalizedSubsections.length > 0 ||
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
          .map((c) => splitSentences(c.content)[0] || cleanChunkTextForAi(c.content).slice(0, 180))
          .join(" ");
      const keyPoints = Array.isArray(aiPart?.keyPoints)
        ? aiPart!.keyPoints.map((k) => String(k).trim()).filter(Boolean)
        : [];

      // Synthesize clean subsections if model omitted subsections array
      if (normalizedSubsections.length === 0) {
        normalizedSubsections.push({
          icon: "🎯",
          title: "Notions & Mécanismes Clés",
          callouts: [
            {
              type: "DEFINITION",
              icon: "💡",
              title: "Synthèse Essentielle",
              text: summaryText,
            },
          ],
          bullets: keyPoints.map((kp) => ({ text: kp })),
          table: null,
        });
      }

      sections.push({
        title: sectionTitle,
        pageRange: pageSpan,
        content: summaryText,
        keyPoints,
        subsections: normalizedSubsections,
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
      const { definitions, quantFacts } = extractCourseFacts(segChunks);
      const fallbackSubsections: SummarySubSection[] = [];

      if (definitions.length > 0) {
        fallbackSubsections.push({
          icon: "🎯",
          title: "Définitions & Notions Extraites",
          callouts: [
            {
              type: "DEFINITION",
              icon: "💡",
              title: definitions[0].term,
              text: definitions[0].explanation,
            },
          ],
          bullets: definitions.slice(1, 8).map((d) => ({
            lead: d.term,
            text: d.explanation,
          })),
        });
      }

      if (quantFacts.length > 0) {
        fallbackSubsections.push({
          icon: "📊",
          title: "Repères & Valeurs Clés à Retenir",
          callouts: [
            {
              type: "KEY_DATE",
              icon: "⚠️",
              title: "Chiffres & Seuils du Cours",
              items: quantFacts
                .slice(0, 5)
                .map((q) => `**${q.exactValue}** — ${q.contextSentence}`),
            },
          ],
        });
      }

      const fallbackText = segChunks
        .slice(0, 3)
        .map(
          (c) =>
            splitSentences(c.content)[0] ||
            cleanChunkTextForAi(c.content).slice(0, 180)
        )
        .join(" ");

      const fallbackPoints = segChunks
        .slice(0, 4)
        .map(
          (c) =>
            splitSentences(c.content)[0] ||
            cleanChunkTextForAi(c.content).slice(0, 140)
        )
        .filter(Boolean);

      if (fallbackSubsections.length === 0) {
        fallbackSubsections.push({
          icon: "📜",
          title: segChunks[0]?.chapterTitle || "Points Essentiels",
          bullets: fallbackPoints.map((pt) => ({ text: pt })),
        });
      }

      sections.push({
        title: fullCourseMode
          ? `Partie ${sIdx + 1} · ${segChunks[0]?.chapterTitle || "Section"}`
          : defaultTopic,
        pageRange: pageSpan,
        content: fallbackText,
        keyPoints: fallbackPoints,
        subsections: fallbackSubsections,
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

export function isStalePublicArtifact(
  kind: StudioArtifactKind | string,
  contentJson: string
): boolean {
  try {
    const parsed = JSON.parse(contentJson) as Partial<StudioArtifactContent> & {
      questions?: RevisionQuestion[];
      cards?: FlashcardItem[];
      sections?: SummarySection[];
    };
    if (kind === "QUIZ") {
      const qs = Array.isArray(parsed.questions) ? parsed.questions : [];
      if (qs.length === 0) return true;
      const anyAi = qs.some((q) => Boolean(q.generatedByAi));
      if (!anyAi) return true;
      return qs.some((q) => isLowQualityExcerptQuestion(q.prompt || "", q.options));
    }
    if (kind === "FLASHCARDS") {
      const cards = Array.isArray(parsed.cards) ? parsed.cards : [];
      if (cards.length === 0) return true;
      return cards.some((c) =>
        /notion clé\s*\(|quel élément faut-il maîtriser/i.test(c.front || "")
      );
    }
    if (kind === "SUMMARY") {
      const secs = Array.isArray(parsed.sections) ? parsed.sections : [];
      if (secs.length === 0) return true;
      return !secs.some(
        (s) => Array.isArray(s.subsections) && s.subsections.length > 0
      );
    }
    return false;
  } catch {
    return true;
  }
}

async function findValidPublicArtifactId(
  documentId: string,
  kind: StudioArtifactKind
): Promise<{ validId: string | null; staleId: string | null }> {
  const rows = await prisma.studyArtifact.findMany({
    where: {
      documentId,
      kind,
      isPublic: true,
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, contentJson: true },
  });
  for (const r of rows) {
    if (!isStalePublicArtifact(kind, r.contentJson)) {
      return { validId: r.id, staleId: null };
    }
  }
  return { validId: null, staleId: rows[0]?.id || null };
}

export async function hasExistingPublicArtifact(
  documentId: string | null | undefined,
  kind: StudioArtifactKind
): Promise<boolean> {
  if (!documentId) return false;
  await ensureStudioSchema();
  const { validId } = await findValidPublicArtifactId(documentId, kind);
  return Boolean(validId);
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
        contentJson: true,
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
    if (row.documentId && !isStalePublicArtifact(row.kind, row.contentJson)) {
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

  const nowHour = getParisHour();
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
  const h = getParisHour();
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

          const { validId, staleId } = await findValidPublicArtifactId(
            doc.id,
            spec.kind
          );
          if (validId) {
            continue;
          }

          try {
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

              if (staleId) {
                await prisma.studyArtifact.update({
                  where: { id: staleId },
                  data: {
                    title: generated.title,
                    contentJson: JSON.stringify(generated.content),
                    isPublic: true,
                    createdAt: new Date(),
                  },
                });
              } else {
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
              }
              generatedCount += 1;
            }

            state.completedItemsInRun += 1;
          } catch (err) {
            console.error(
              `[NightlyAI] Failed for doc ${doc.id} (${spec.kind}):`,
              err
            );
            state.completedItemsInRun += 1;
          }
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
