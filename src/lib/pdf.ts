export interface ExtractedPdfPage {
  pageNumber: number;
  text: string;
  imageCount?: number;
}

export interface ExtractedPdfResult {
  pageCount: number;
  pages: ExtractedPdfPage[];
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
        const figureHints = extractFigureLegendHints(baseText);

        let enrichedText = baseText;
        if (imageCount > 0 || figureHints.length > 0) {
          const visualTag = `[REPÈRE VISUEL PAGE ${pageNum} : ${imageCount} image(s)/figure(s) détectée(s)${
            figureHints.length > 0
              ? ` · Légendes : ${figureHints.join(" | ")}`
              : ""
          }]`;
          enrichedText = baseText ? `${baseText}\n${visualTag}` : visualTag;
        }

        pages.push({
          pageNumber: pageNum,
          text: enrichedText,
          imageCount,
        });
        return enrichedText;
      },
    });

    const pageCount = Math.max(data.numpages || pages.length || 1, 1);
    if (pages.length === 0 && data.text?.trim()) {
      pages.push({ pageNumber: 1, text: data.text.trim() });
    }

    return { pageCount, pages };
  } catch (error) {
    console.error("[PDF] Extraction error:", error);
    return { pageCount: 1, pages: [] };
  }
}
