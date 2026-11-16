export interface ExtractedPdfPage {
  pageNumber: number;
  text: string;
}

export interface ExtractedPdfResult {
  pageCount: number;
  pages: ExtractedPdfPage[];
}

interface PdfPageData {
  getTextContent: () => Promise<{
    items: Array<{ str?: string; hasEOL?: boolean }>;
  }>;
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
        const pageText = pieces.join(" ").replace(/\s+/g, " ").trim();
        pages.push({
          pageNumber: pageNum,
          text: pageText,
        });
        return pageText;
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
