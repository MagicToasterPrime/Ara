import crypto from "node:crypto";
import { prisma } from "@/lib/prisma";
import {
  checkOllamaHealth,
  describeImageWithOllama,
  formatVectorLiteral,
  generateEmbedding,
  getOllamaConfig,
} from "@/lib/ollama";
import type { RevisionQuestion } from "@/lib/revisions";

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

export interface SummaryPayload {
  kind: "SUMMARY";
  overview: string;
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
}): Promise<SourceChunk[]> {
  const { ueId, documentIds, pageNumber, prompt } = params;
  const docFilter =
    Array.isArray(documentIds) && documentIds.length > 0
      ? documentIds
      : undefined;

  const collected: SourceChunk[] = [];
  const seen = new Set<string>();

  const pushChunk = (c: SourceChunk) => {
    if (!seen.has(c.id)) {
      seen.add(c.id);
      collected.push(c);
    }
  };

  // 1. If a specific page of a single document is active, prioritize it
  if (docFilter && docFilter.length === 1 && pageNumber && pageNumber > 0) {
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

  // 2. If prompt is provided and embeddings are available, fetch vector matches
  if (prompt && prompt.trim().length > 2) {
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
  }

  // 3. Fill up with representative chunks from the selected documents / UE
  if (collected.length < 8) {
    const rows = await prisma.documentChunk.findMany({
      where: docFilter
        ? { documentId: { in: docFilter } }
        : ueId
        ? { document: { chapter: { ueId } } }
        : undefined,
      take: 14,
      orderBy: [{ pageNumber: "asc" }],
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
      if (collected.length >= 10) break;
    }
  }

  return collected;
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

async function callOllamaJson<T>(prompt: string): Promise<T | null> {
  const health = await checkOllamaHealth();
  if (!health.online) return null;

  const { host, model } = getOllamaConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 16000);

  try {
    const res = await fetch(`${host}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        format: "json",
        stream: false,
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { response?: string };
    if (!data.response) return null;
    return JSON.parse(data.response) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 25);
}

export interface PageImageInput {
  pageNumber: number;
  documentTitle?: string;
  base64: string;
}

export async function generateStudioArtifact(params: {
  kind: StudioArtifactKind;
  chunks: SourceChunk[];
  title?: string;
  prompt?: string;
  pageImagesBase64?: PageImageInput[];
}): Promise<{ title: string; content: StudioArtifactContent }> {
  const { kind, chunks, prompt, pageImagesBase64 } = params;
  const sources = buildSourceRefs(chunks);

  // Prioritize chunks that contain visual figure markers alongside regular chunks
  const orderedChunks = [
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
    visualContextNote +
    orderedChunks
      .slice(0, 6)
      .map(
        (c) =>
          `[${c.fileName} · P.${c.pageNumber}] (${c.ueCode} - ${c.chapterTitle})\n${c.content}`
      )
      .join("\n\n");

  const defaultTopic =
    prompt?.trim() ||
    chunks[0]?.documentTitle ||
    chunks[0]?.ueTitle ||
    "Synthèse de cours";

  if (kind === "SVG_DIAGRAM") {
    const aiDiagram = await callOllamaJson<{
      title?: string;
      subtitle?: string;
      layout?: "FLOW" | "HIERARCHY" | "RADIAL";
      nodes?: SvgNodeSpec[];
      edges?: SvgEdgeSpec[];
    }>(
      `À partir des extraits de cours suivants, conçois un schéma conceptuel structuré en français répondant à : "${defaultTopic}".
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

    if (
      aiDiagram?.nodes &&
      Array.isArray(aiDiagram.nodes) &&
      aiDiagram.nodes.length >= 2
    ) {
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
      // Deterministic node/edge diagram extraction from course chunks
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

    return {
      title: diagramTitle,
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
    const title = params.title?.trim() || `Flashcards : ${defaultTopic}`;
    const aiCards = await callOllamaJson<{
      cards?: Array<{ front?: string; back?: string; tag?: string }>;
    }>(
      `Génère 6 flashcards recto/verso de révision universitaire en français sur : "${defaultTopic}".
Réponds STRICTEMENT en JSON :
{
  "cards": [
    { "front": "Question précise au recto ?", "back": "Réponse concise et rigoureuse au verso.", "tag": "NOTION" }
  ]
}

EXTRAITS :
${contextText}`
    );

    let cards: FlashcardItem[] = [];
    if (aiCards?.cards && Array.isArray(aiCards.cards) && aiCards.cards.length > 0) {
      cards = aiCards.cards
        .filter((c) => c.front && c.back)
        .slice(0, 8)
        .map((c, idx) => {
          const src = chunks[idx % chunks.length];
          return {
            id: `fc-${crypto.randomUUID().slice(0, 6)}`,
            front: String(c.front),
            back: String(c.back),
            tag: String(c.tag || src?.ueCode || "COURS"),
            documentId: src?.documentId || "",
            fileName: src?.fileName || "document.pdf",
            pageNumber: src?.pageNumber || 1,
            ueId: src?.ueId || "",
          };
        });
    }

    if (cards.length === 0) {
      cards = chunks.slice(0, 6).map((c, idx) => {
        const sents = splitSentences(c.content);
        const answer = sents[0] || c.content.slice(0, 180);
        return {
          id: `fc-${idx + 1}`,
          front: `Que précise « ${c.documentTitle} » (${c.chapterTitle}, p.${c.pageNumber}) sur ce point clé ?`,
          back: answer,
          tag: c.ueCode,
          documentId: c.documentId,
          fileName: c.fileName,
          pageNumber: c.pageNumber,
          ueId: c.ueId,
        };
      });
    }

    return {
      title,
      content: {
        kind: "FLASHCARDS",
        cards,
        sources,
      },
    };
  }

  if (kind === "QUIZ") {
    const title = params.title?.trim() || `Quiz ciblé : ${defaultTopic}`;
    const aiQuiz = await callOllamaJson<{
      questions?: Array<{
        type?: "QCU" | "QCM" | "FILL_BLANK";
        prompt?: string;
        options?: string[];
        correctIndices?: number[];
        sentenceWithBlank?: string;
        correctAnswer?: string;
        distractors?: string[];
        explanation?: string;
      }>;
    }>(
      `Génère 4 questions de quiz universitaire en français sur : "${defaultTopic}".
Inclus des QCU (1 bonne réponse), QCM (2 bonnes réponses) et FILL_BLANK (avec [ ______ ]).
Réponds STRICTEMENT en JSON :
{
  "questions": [
    {
      "type": "QCU",
      "prompt": "...",
      "options": ["A", "B", "C", "D"],
      "correctIndices": [0],
      "explanation": "..."
    }
  ]
}

EXTRAITS :
${contextText}`
    );

    const questions: RevisionQuestion[] = [];

    if (aiQuiz?.questions && Array.isArray(aiQuiz.questions)) {
      aiQuiz.questions.slice(0, 5).forEach((q, idx) => {
        const src = chunks[idx % chunks.length];
        if (!src || !q.prompt) return;

        if (
          (q.type === "QCU" || q.type === "QCM") &&
          Array.isArray(q.options) &&
          q.options.length === 4 &&
          Array.isArray(q.correctIndices) &&
          q.correctIndices.length > 0
        ) {
          questions.push({
            id: `sq-${idx + 1}`,
            type: q.type,
            ueId: src.ueId,
            ueCode: src.ueCode,
            ueTitle: src.ueTitle,
            chapterTitle: src.chapterTitle,
            documentId: src.documentId,
            documentTitle: src.documentTitle,
            fileName: src.fileName,
            pageNumber: src.pageNumber,
            prompt: q.prompt,
            options: q.options,
            correctIndices: q.correctIndices,
            explanation:
              q.explanation ||
              `Source : ${src.documentTitle} (p.${src.pageNumber}).`,
          });
        } else if (
          q.type === "FILL_BLANK" &&
          q.sentenceWithBlank &&
          q.correctAnswer
        ) {
          const bank = [
            q.correctAnswer,
            ...(Array.isArray(q.distractors) ? q.distractors.slice(0, 3) : []),
          ];
          questions.push({
            id: `sq-${idx + 1}`,
            type: "FILL_BLANK",
            ueId: src.ueId,
            ueCode: src.ueCode,
            ueTitle: src.ueTitle,
            chapterTitle: src.chapterTitle,
            documentId: src.documentId,
            documentTitle: src.documentTitle,
            fileName: src.fileName,
            pageNumber: src.pageNumber,
            prompt: q.prompt,
            sentenceWithBlank: q.sentenceWithBlank,
            correctAnswer: q.correctAnswer,
            wordBank: bank,
            explanation:
              q.explanation ||
              `Terme attendu : « ${q.correctAnswer} » (p.${src.pageNumber}).`,
          });
        }
      });
    }

    if (questions.length === 0) {
      chunks.slice(0, 3).forEach((src, idx) => {
        const sents = splitSentences(src.content);
        const correct = sents[0] || src.content.slice(0, 160);
        const other = chunks[(idx + 1) % chunks.length];
        const otherSent =
          splitSentences(other?.content || "")[0] ||
          "Proposition sans lien direct avec cette page.";
        questions.push({
          id: `sq-${idx + 1}`,
          type: "QCU",
          ueId: src.ueId,
          ueCode: src.ueCode,
          ueTitle: src.ueTitle,
          chapterTitle: src.chapterTitle,
          documentId: src.documentId,
          documentTitle: src.documentTitle,
          fileName: src.fileName,
          pageNumber: src.pageNumber,
          prompt: `D'après « ${src.documentTitle} » (${src.ueCode}, p.${src.pageNumber}), quel énoncé est exact ?`,
          options: [
            correct,
            otherSent,
            `Cette section ne traite pas de ${src.chapterTitle}.`,
            `Assertion contradictoire avec la page ${src.pageNumber}.`,
          ],
          correctIndices: [0],
          explanation: `Extrait direct de ${src.fileName} (page ${src.pageNumber}).`,
        });
      });
    }

    return {
      title,
      content: {
        kind: "QUIZ",
        questions,
        sources,
      },
    };
  }

  // SUMMARY
  const title = params.title?.trim() || `Fiche Synthèse : ${defaultTopic}`;
  const aiSummary = await callOllamaJson<{
    overview?: string;
    keyConcepts?: Array<{ term?: string; definition?: string }>;
    examPitfalls?: string[];
  }>(
    `Rédige une fiche de synthèse structurée style NotebookLM en français sur : "${defaultTopic}".
Réponds STRICTEMENT en JSON :
{
  "overview": "Paragraphe de synthèse clair et structuré (4-6 lignes).",
  "keyConcepts": [
    { "term": "Concept clé", "definition": "Définition précise issue du cours" }
  ],
  "examPitfalls": ["Piège fréquent ou point de vigilance au partiel"]
}

EXTRAITS :
${contextText}`
  );

  const overview =
    aiSummary?.overview ||
    chunks
      .slice(0, 3)
      .map((c) => splitSentences(c.content)[0] || c.content.slice(0, 180))
      .join(" ");

  const keyConcepts =
    aiSummary?.keyConcepts && aiSummary.keyConcepts.length > 0
      ? aiSummary.keyConcepts.slice(0, 6).map((kc, idx) => {
          const src = chunks[idx % chunks.length];
          return {
            term: kc.term || `Notion ${idx + 1}`,
            definition: kc.definition || "",
            sourceLabel: `[${src.fileName.toUpperCase()} · P.${src.pageNumber}]`,
            documentId: src.documentId,
            pageNumber: src.pageNumber,
            ueId: src.ueId,
          };
        })
      : chunks.slice(0, 4).map((c) => ({
          term: c.chapterTitle,
          definition: splitSentences(c.content)[0] || c.content.slice(0, 180),
          sourceLabel: `[${c.fileName.toUpperCase()} · P.${c.pageNumber}]`,
          documentId: c.documentId,
          pageNumber: c.pageNumber,
          ueId: c.ueId,
        }));

  const examPitfalls =
    aiSummary?.examPitfalls && aiSummary.examPitfalls.length > 0
      ? aiSummary.examPitfalls
      : [
          "Vérifier les définitions exactes et les seuils numériques dans les polycopiés officiels.",
          "Relier chaque mécanisme aux schémas présentés en cours.",
        ];

  return {
    title,
    content: {
      kind: "SUMMARY",
      overview,
      keyConcepts,
      examPitfalls,
      sources,
    },
  };
}
