import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface OcrToolsStatus {
  available: boolean;
  hasPdftoppm: boolean;
  hasTesseract: boolean;
}

export interface OcrExtractedPage {
  pageNumber: number;
  text: string;
  imageCount: number;
  rawTextLength: number;
}

const globalForOcr = globalThis as typeof globalThis & {
  __araOcrToolsCache?: { status: OcrToolsStatus; checkedAt: number };
};

async function commandExists(bin: string, args: string[]): Promise<boolean> {
  try {
    await execFileAsync(bin, args, { timeout: 5000 });
    return true;
  } catch (err) {
    // Some CLI tools exit non-zero on help flags; ENOENT means binary is missing
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return false;
    }
    return false;
  }
}

export async function checkOcrToolsAvailable(): Promise<OcrToolsStatus> {
  const cached = globalForOcr.__araOcrToolsCache;
  if (cached && Date.now() - cached.checkedAt < 60_000) {
    return cached.status;
  }

  const [hasPdftoppm, hasTesseract] = await Promise.all([
    commandExists("pdftoppm", ["-v"]),
    commandExists("tesseract", ["--version"]),
  ]);

  const status: OcrToolsStatus = {
    available: hasPdftoppm && hasTesseract,
    hasPdftoppm,
    hasTesseract,
  };
  globalForOcr.__araOcrToolsCache = { status, checkedAt: Date.now() };
  return status;
}

function basicNormalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function countAlnumChars(text: string): number {
  const m = text.match(/[a-zA-ZÀ-ÿ0-9]/g);
  return m ? m.length : 0;
}

/**
 * Fallback OCR pipeline (`pdftoppm` -> grayscale PNG 150dpi -> `tesseract`) for scanned PDFs.
 * Always cleans up its temporary working folder in `finally`.
 */
export async function extractPdfTextViaOcr(
  buffer: Buffer,
  maxPages = 50,
  normalizeFn: (raw: string) => string = basicNormalizeText
): Promise<{
  used: boolean;
  pages: OcrExtractedPage[];
  totalTextChars: number;
}> {
  const tools = await checkOcrToolsAvailable();
  if (!tools.available) {
    return { used: false, pages: [], totalTextChars: 0 };
  }

  const safeMaxPages = Math.max(1, Math.min(80, maxPages || 50));
  const workDir = path.join(os.tmpdir(), `ara-ocr-${crypto.randomUUID()}`);

  try {
    await fsp.mkdir(workDir, { recursive: true });
    const pdfPath = path.join(workDir, "input.pdf");
    await fsp.writeFile(pdfPath, buffer);

    await execFileAsync(
      "pdftoppm",
      [
        "-png",
        "-gray",
        "-r",
        "150",
        "-f",
        "1",
        "-l",
        String(safeMaxPages),
        pdfPath,
        path.join(workDir, "page"),
      ],
      { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }
    );

    const entries = await fsp.readdir(workDir);
    const pngFiles = entries
      .filter((name) => /^page-\d+\.png$/i.test(name))
      .sort((a, b) => {
        const na = Number.parseInt(a.replace(/\D+/g, ""), 10) || 0;
        const nb = Number.parseInt(b.replace(/\D+/g, ""), 10) || 0;
        return na - nb;
      });

    const pages: OcrExtractedPage[] = [];
    let totalTextChars = 0;

    for (let i = 0; i < pngFiles.length; i += 1) {
      const file = pngFiles[i];
      const pageNumMatch = file.match(/(\d+)/);
      const pageNumber = pageNumMatch
        ? Number.parseInt(pageNumMatch[1], 10)
        : i + 1;
      const imgPath = path.join(workDir, file);

      let ocrRaw = "";
      try {
        const res = await execFileAsync(
          "tesseract",
          [imgPath, "stdout", "-l", "fra+eng", "--psm", "6"],
          { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 }
        );
        ocrRaw = res.stdout || "";
      } catch {
        try {
          const fallback = await execFileAsync(
            "tesseract",
            [imgPath, "stdout", "-l", "eng", "--psm", "6"],
            { timeout: 45_000, maxBuffer: 8 * 1024 * 1024 }
          );
          ocrRaw = fallback.stdout || "";
        } catch {
          ocrRaw = "";
        }
      }

      const cleaned = normalizeFn(ocrRaw);
      const charLen = countAlnumChars(cleaned);
      if (charLen > 0) {
        totalTextChars += charLen;
        pages.push({
          pageNumber,
          text: cleaned,
          imageCount: 1,
          rawTextLength: charLen,
        });
      }
    }

    return {
      used: true,
      pages,
      totalTextChars,
    };
  } catch (err) {
    console.warn(
      "[OCR] Erreur lors de la conversion/OCR du PDF:",
      err instanceof Error ? err.message : err
    );
    return { used: false, pages: [], totalTextChars: 0 };
  } finally {
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => null);
  }
}
