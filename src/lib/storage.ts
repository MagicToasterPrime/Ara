import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

export function getUploadDir(): string {
  const configured = process.env.UPLOAD_DIR || "./storage/uploads";
  return path.resolve(process.cwd(), configured);
}

export async function ensureUploadDir(): Promise<string> {
  const dir = getUploadDir();
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

export function sanitizeFileName(name: string): string {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._-]/g, "_");
  return base || "document.pdf";
}

export function resolveDocumentFilePath(localPath: string): string {
  const uploadDir = getUploadDir();
  const resolved = path.isAbsolute(localPath)
    ? path.resolve(localPath)
    : path.resolve(process.cwd(), localPath);

  if (!resolved.startsWith(uploadDir)) {
    throw new Error("Accès fichier hors du répertoire de stockage autorisé");
  }
  return resolved;
}

export async function getStorageStats(): Promise<{
  uploadDir: string;
  fileCount: number;
  totalBytes: number;
}> {
  const uploadDir = getUploadDir();
  if (!fs.existsSync(uploadDir)) {
    return { uploadDir, fileCount: 0, totalBytes: 0 };
  }

  let fileCount = 0;
  let totalBytes = 0;

  async function walk(currentDir: string) {
    const entries = await fsp.readdir(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(fullPath);
        fileCount += 1;
        totalBytes += stat.size;
      }
    }
  }

  await walk(uploadDir);
  return { uploadDir, fileCount, totalBytes };
}
