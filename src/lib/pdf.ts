export interface ExtractedPdfPage {
  pageNumber: number;
  text: string;
  imageCount?: number;
  rawTextLength?: number;
}

export interface ExtractedPdfResult {
  pageCount: number;
  pages: ExtractedPdfPage[];
  hasExtractableText: boolean;
  totalTextChars: number;
  parseError?: string;
}

interface PdfPageData {
  getTextContent: () => Promise<{
    items: Array<{ str?: string; hasEOL?: boolean }>;
  }>;
  getOperatorList?: () => Promise<{
    fnArray?: number[];
  }>;
}

// PDF.js drawing operator codes for embedded raster/inline images
const IMAGE_OPS = new Set([82, 83, 84, 85, 86, 87, 88]);

/**
 * Minimum number of real alphanumeric characters required across a PDF
 * to consider it text-exploitable (below this, the PDF is likely a pure image scan).
 */
export const MIN_USABLE_TEXT_CHARS = 30;

export function stripVisualMarkers(text: string): string {
  return text.replace(/\[REP[ÈE]RE VISUEL[^\]]*\]/gi, " ");
}

export function getMeaningfulTextLength(text: string): number {
  const withoutTags = stripVisualMarkers(text);
  const alnum = withoutTags.match(/[a-zA-ZÀ-ÿ0-9]/g);
  return alnum ? alnum.length : 0;
}

export function hasUsableText(
  text: string,
  minChars = MIN_USABLE_TEXT_CHARS
): boolean {
  return getMeaningfulTextLength(text) >= minChars;
}

export function hasUsableExtractedText(
  pages: Array<{ text: string; rawTextLength?: number }>,
  minChars = MIN_USABLE_TEXT_CHARS
): boolean {
  let total = 0;
  for (const page of pages) {
    total +=
      typeof page.rawTextLength === "number"
        ? page.rawTextLength
        : getMeaningfulTextLength(page.text || "");
    if (total >= minChars) return true;
  }
  return false;
}

function extractFigureLegendHints(pageText: string): string[] {
  const matches: string[] = [];
  const regex =
    /(?:fig(?:ure)?\.?|sch[eé]ma|planche|coupe|diagramme|l[eé]gende)\s*[^.!?;\n]{3,90}/gi;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(pageText)) !== null && matches.length < 4) {
    const cleaned = m[0].replace(/\s+/g, " ").trim();
    if (cleaned) matches.push(cleaned);
  }
  return matches;
}

export async function extractPdfPages(
  buffer: Buffer
): Promise<ExtractedPdfResult> {
  try {
    // Dynamic require so Next.js serverComponentsExternalPackages loads pdf-parse cleanly at runtime
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pdfParse = require("pdf-parse/lib/pdf-parse.js") as (
      dataBuffer: Buffer,
      options?: { pagerender?: (pageData: PdfPageData) => Promise<string> }
    ) => Promise<{ numpages: number; text: string }>;

    const pages: ExtractedPdfPage[] = [];
    let currentIndex = 0;

    const data = await pdfParse(buffer, {
      pagerender: async (pageData: PdfPageData) => {
        currentIndex += 1;
        const pageNum = currentIndex;
        const textContent = await pageData.getTextContent();
        let lastText = "";
        const pieces: string[] = [];
        for (const item of textContent.items) {
          const str = item.str ?? "";
          if (str) {
            pieces.push(str);
            lastText = str;
          }
          if (item.hasEOL && lastText !== "\n") {
            pieces.push("\n");
          }
        }

        let imageCount = 0;
        if (typeof pageData.getOperatorList === "function") {
          try {
            const opList = await pageData.getOperatorList();
            if (Array.isArray(opList?.fnArray)) {
              for (const fn of opList.fnArray) {
                if (IMAGE_OPS.has(fn)) {
                  imageCount += 1;
                }
              }
            }
          } catch {
            // Operator list inspection optional
          }
        }

        const baseText = pieces.join(" ").replace(/\s+/g, " ").trim();
        const rawTextLength = getMeaningfulTextLength(baseText);
        const figureHints = extractFigureLegendHints(baseText);

        // Only attach visual markers when the page has real text; avoid generating
        // synthetic-only chunks on scanned image-only pages.
        let enrichedText = baseText;
        if (rawTextLength > 0 && (imageCount > 0 || figureHints.length > 0)) {
          const visualTag = `[REPÈRE VISUEL PAGE ${pageNum} : ${imageCount} image(s)/figure(s) détectée(s)${
            figureHints.length > 0
              ? ` · Légendes : ${figureHints.join(" | ")}`
              : ""
          }]`;
          enrichedText = `${baseText}\n${visualTag}`;
        }

        pages.push({
          pageNumber: pageNum,
          text: enrichedText,
          imageCount,
          rawTextLength,
        });
        return enrichedText;
      },
    });

    const pageCount = Math.max(data.numpages || pages.length || 1, 1);
    if (pages.length === 0 && data.text?.trim()) {
      const cleaned = data.text.trim();
      pages.push({
        pageNumber: 1,
        text: cleaned,
        rawTextLength: getMeaningfulTextLength(cleaned),
      });
    }

    const totalTextChars = pages.reduce(
      (sum, p) => sum + (p.rawTextLength ?? getMeaningfulTextLength(p.text)),
      0
    );
    const hasExtractableText = totalTextChars >= MIN_USABLE_TEXT_CHARS;

    if (!hasExtractableText) {
      console.error(
        `[PDF] Extraction vide : aucun texte exploitable détecté (${totalTextChars} caractères alphanumériques sur ${pageCount} page(s) — PDF probablement scanné sans couche OCR).`
      );
      return {
        pageCount,
        pages: [],
        hasExtractableText: false,
        totalTextChars,
      };
    }

    const nonEmptyPages = pages.filter(
      (p) => (p.rawTextLength ?? getMeaningfulTextLength(p.text)) > 0
    );

    return {
      pageCount,
      pages: nonEmptyPages,
      hasExtractableText: true,
      totalTextChars,
    };
  } catch (error) {
    const parseError =
      error instanceof Error ? error.message : "PDF corrompu ou illisible";
    console.error("[PDF] Extraction error:", error);
    return {
      pageCount: 0,
      pages: [],
      hasExtractableText: false,
      totalTextChars: 0,
      parseError,
    };
  }
}
