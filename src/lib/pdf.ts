import { extractPdfTextViaOcr } from "@/lib/ocr";
import { logSystemError } from "@/lib/system-logger";

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
  ocrUsed?: boolean;
  parseError?: string;
}

interface PdfPageData {
  getTextContent: () => Promise<{
    items: Array<{
      str?: string;
      width?: number;
      height?: number;
      transform?: number[];
      hasEOL?: boolean;
    }>;
  }>;
}

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

export function normalizePdfExtractedText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/\uFFFD/g, "")
    .replace(/\uFB00/g, "ff")
    .replace(/\uFB01/g, "fi")
    .replace(/\uFB02/g, "fl")
    .replace(/\uFB03/g, "ffi")
    .replace(/\uFB04/g, "ffl")
    .replace(/[\uFB05\uFB06]/g, "st")
    .replace(/([a-zA-ZÀ-ÿœŒ])[\u01AF\u01B0]([a-zA-ZÀ-ÿœŒ])/g, "$1ff$2")
    .replace(/(^|[\s(['"«-])[\u01AF\u01B0]([a-zà-ÿœ]{2,})/g, "$1ff$2")
    .replace(/^[ \t]*[\uE000-\uF8FF]+[ \t]*/gm, "• ")
    .replace(/[\uE000-\uF8FF]+/g, " ")
    .replace(/([a-zA-ZÀ-ÿœŒ]{2,})-[ \t]*\n[ \t]*([a-zà-ÿœ]{2,})/g, "$1$2")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

        interface ReconstructedLine {
          raw: string;
          breakBefore: "" | "\n" | "\n\n";
          fontWeights: Map<number, number>;
        }

        const lines: ReconstructedLine[] = [];
        const pageFontWeights: Array<{ size: number; weight: number }> = [];
        let currentLine: ReconstructedLine | null = null;
        let lastY: number | null = null;
        let lastEndX: number | null = null;
        let lastFontSize = 10;

        const pushCurrentLine = () => {
          if (currentLine) {
            lines.push(currentLine);
            currentLine = null;
          }
        };

        for (const item of textContent.items) {
          const str = item.str ?? "";
          const hasTransform =
            Array.isArray(item.transform) &&
            item.transform.length >= 6 &&
            Number.isFinite(item.transform[4]) &&
            Number.isFinite(item.transform[5]);

          const x = hasTransform ? item.transform![4] : 0;
          const y = hasTransform ? item.transform![5] : 0;
          const rawFontSize = hasTransform
            ? Math.hypot(item.transform![0] || 0, item.transform![1] || 0) ||
              Math.abs(item.transform![3] || 0) ||
              item.height ||
              10
            : item.height || 10;
          const fontSize =
            Number.isFinite(rawFontSize) && rawFontSize > 0 ? rawFontSize : 10;

          if (!str) {
            if (item.hasEOL && currentLine) {
              pushCurrentLine();
              lastY = null;
              lastEndX = null;
            }
            continue;
          }

          const isWhitespaceOnly = str.trim().length === 0;
          if (isWhitespaceOnly) {
            if (
              currentLine &&
              (!hasTransform ||
                lastY === null ||
                Math.abs(y - lastY) <=
                  Math.max(2.2, Math.min(fontSize, lastFontSize) * 0.38))
            ) {
              if (!currentLine.raw.endsWith(" ")) {
                currentLine.raw += " ";
              }
              if (hasTransform) {
                lastEndX = x + (item.width || 0);
              }
            }
            if (item.hasEOL && currentLine) {
              pushCurrentLine();
              lastY = null;
              lastEndX = null;
            }
            continue;
          }

          let startedNewLine = false;
          let breakBefore: "" | "\n" | "\n\n" = "";

          if (!currentLine) {
            startedNewLine = true;
            breakBefore = lines.length > 0 ? "\n" : "";
          } else if (hasTransform && lastY !== null) {
            const dy = Math.abs(y - lastY);
            const lineThreshold = Math.max(
              2.2,
              Math.min(fontSize, lastFontSize) * 0.38
            );
            if (dy > lineThreshold) {
              pushCurrentLine();
              startedNewLine = true;
              breakBefore =
                dy > Math.max(fontSize, lastFontSize) * 1.75 ? "\n\n" : "\n";
            }
          }

          if (startedNewLine || !currentLine) {
            currentLine = {
              raw: "",
              breakBefore,
              fontWeights: new Map(),
            };
            lastEndX = null;
          } else if (hasTransform && lastEndX !== null) {
            const gap = x - lastEndX;
            if (gap > fontSize * 2.5) {
              currentLine.raw += " | ";
            } else if (
              gap > fontSize * 0.14 &&
              !currentLine.raw.endsWith(" ") &&
              !str.startsWith(" ")
            ) {
              currentLine.raw += " ";
            }
          } else if (
            !hasTransform &&
            currentLine.raw.length > 0 &&
            !currentLine.raw.endsWith(" ") &&
            !str.startsWith(" ")
          ) {
            currentLine.raw += " ";
          }

          currentLine.raw += str;

          const nonSpaceLen = str.replace(/\s+/g, "").length;
          if (nonSpaceLen > 0) {
            const bucket = Math.round(fontSize * 10) / 10;
            currentLine.fontWeights.set(
              bucket,
              (currentLine.fontWeights.get(bucket) || 0) + nonSpaceLen
            );
            pageFontWeights.push({ size: bucket, weight: nonSpaceLen });
          }

          if (hasTransform) {
            lastY = y;
            lastEndX = x + (item.width || 0);
            lastFontSize = fontSize;
          }

          if (item.hasEOL) {
            pushCurrentLine();
            lastY = null;
            lastEndX = null;
          }
        }
        pushCurrentLine();

        let medianFontSize = 10;
        if (pageFontWeights.length > 0) {
          pageFontWeights.sort((a, b) => a.size - b.size);
          const totalWeight = pageFontWeights.reduce(
            (sum, entry) => sum + entry.weight,
            0
          );
          let cumulative = 0;
          for (const entry of pageFontWeights) {
            cumulative += entry.weight;
            if (cumulative >= totalWeight * 0.5) {
              medianFontSize = entry.size;
              break;
            }
          }
        }

        let assembled = "";
        let pendingBreak: "" | "\n" | "\n\n" = "";
        for (const line of lines) {
          const normLine = normalizePdfExtractedText(line.raw);
          if (!normLine) {
            if (assembled) {
              pendingBreak =
                line.breakBefore === "\n\n" ? "\n\n" : pendingBreak || "\n";
            }
            continue;
          }

          let dominantFontSize = medianFontSize;
          let maxFontWeight = -1;
          for (const [size, weight] of Array.from(line.fontWeights.entries())) {
            if (weight > maxFontWeight) {
              maxFontWeight = weight;
              dominantFontSize = size;
            }
          }

          const letterCount = (normLine.match(/[a-zA-ZÀ-ÿœŒ]/g) || []).length;
          const isHeading =
            normLine.length <= 110 &&
            letterCount >= 3 &&
            !/^[•\-|]/.test(normLine) &&
            !/\.{3}|…/.test(normLine) &&
            dominantFontSize >= medianFontSize * 1.26 &&
            dominantFontSize >= 13;

          const formattedLine = isHeading ? `### ${normLine}` : normLine;
          if (!assembled) {
            assembled = formattedLine;
          } else {
            const sep =
              pendingBreak === "\n\n" || line.breakBefore === "\n\n"
                ? "\n\n"
                : line.breakBefore || "\n";
            assembled += `${sep}${formattedLine}`;
          }
          pendingBreak = "";
        }

        const baseText = normalizePdfExtractedText(assembled);
        const rawTextLength = getMeaningfulTextLength(baseText);
        const figureHints = extractFigureLegendHints(baseText);
        const imageCount = figureHints.length;

        // Only attach visual markers when the page has real text and legend hints;
        // avoid calling pageData.getOperatorList() which triggers FontLoader/Image crashes in pdf.js under Node.js.
        let enrichedText = baseText;
        if (rawTextLength > 0 && figureHints.length > 0) {
          const visualTag = `[REPÈRE VISUEL PAGE ${pageNum} : ${imageCount} image(s)/figure(s) détectée(s) · Légendes : ${figureHints.join(
            " | "
          )}]`;
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
      const cleaned = normalizePdfExtractedText(data.text);
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
      const ocrRes = await extractPdfTextViaOcr(
        buffer,
        Math.min(pageCount, 50),
        normalizePdfExtractedText
      );
      if (
        ocrRes.pages.length > 0 &&
        ocrRes.totalTextChars >= MIN_USABLE_TEXT_CHARS
      ) {
        console.log(
          `[PDF/OCR] Fallback OCR réussi : ${ocrRes.totalTextChars} caractères récupérés sur ${ocrRes.pages.length} page(s).`
        );
        return {
          pageCount: Math.max(pageCount, ocrRes.pages.length),
          pages: ocrRes.pages,
          hasExtractableText: true,
          totalTextChars: ocrRes.totalTextChars,
          ocrUsed: true,
        };
      }

      console.error(
        `[PDF] Extraction vide : aucun texte exploitable détecté (${totalTextChars} caractères alphanumériques sur ${pageCount} page(s) — PDF probablement scanné sans couche OCR).`
      );
      void logSystemError({
        source: "PDF_OCR",
        message: `PDF sans texte exploitable (${pageCount} pages, ${totalTextChars} caractères extraits, OCR infructueux ou indisponible).`,
      });
      return {
        pageCount,
        pages: [],
        hasExtractableText: false,
        totalTextChars,
        ocrUsed: ocrRes.used,
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
      ocrUsed: false,
    };
  } catch (error) {
    const parseError =
      error instanceof Error ? error.message : "PDF corrompu ou illisible";
    console.error("[PDF] Extraction error:", error);
    void logSystemError({
      source: "PDF_OCR",
      message: "Erreur de lecture PDF.",
      detail: parseError,
    });
    return {
      pageCount: 0,
      pages: [],
      hasExtractableText: false,
      totalTextChars: 0,
      parseError,
    };
  }
}
