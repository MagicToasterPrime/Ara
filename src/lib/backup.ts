import { execFile } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { prisma } from "@/lib/prisma";
import { logSystemError } from "@/lib/system-logger";

const execFileAsync = promisify(execFile);

export interface BackupFileInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
}

export interface BackupStatus {
  backupDir: string;
  count: number;
  totalBytes: number;
  latestAt: string | null;
  files: BackupFileInfo[];
}

export function getBackupDir(): string {
  return path.join(process.cwd(), "storage", "backups");
}

function buildStamp(date = new Date()): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${y}${m}${d}_${hh}${mm}${ss}`;
}

export async function getBackupStatus(): Promise<BackupStatus> {
  const backupDir = getBackupDir();
  try {
    await fsp.mkdir(backupDir, { recursive: true });
    const entries = await fsp.readdir(backupDir, { withFileTypes: true });
    const files: BackupFileInfo[] = [];
    let totalBytes = 0;

    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!/\.(sql\.gz|json\.gz|tar\.gz)$/i.test(entry.name)) continue;
      const fullPath = path.join(backupDir, entry.name);
      const st = await fsp.stat(fullPath).catch(() => null);
      if (!st) continue;
      totalBytes += st.size;
      files.push({
        name: entry.name,
        sizeBytes: st.size,
        createdAt: st.mtime.toISOString(),
      });
    }

    files.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    return {
      backupDir,
      count: files.length,
      totalBytes,
      latestAt: files[0]?.createdAt ?? null,
      files: files.slice(0, 14),
    };
  } catch (err) {
    console.warn("[Backup] Status read warning:", err);
    return {
      backupDir,
      count: 0,
      totalBytes: 0,
      latestAt: null,
      files: [],
    };
  }
}

export async function runManualBackup(): Promise<{
  ok: boolean;
  mode: "PG_DUMP" | "PRISMA_JSON";
  createdFiles: string[];
  status: BackupStatus;
  warning?: string;
}> {
  const backupDir = getBackupDir();
  await fsp.mkdir(backupDir, { recursive: true });
  const stamp = buildStamp();
  const createdFiles: string[] = [];
  let mode: "PG_DUMP" | "PRISMA_JSON" = "PRISMA_JSON";
  let warning: string | undefined;

  // 1. Database backup: try pg_dump directly via DATABASE_URL first (works without sudo!)
  const dbUrl = process.env.DATABASE_URL?.trim() || "";
  let pgDumpSuccess = false;
  if (dbUrl) {
    try {
      const { stdout } = await execFileAsync(
        "pg_dump",
        ["--dbname", dbUrl, "--no-owner", "--no-acl"],
        { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 }
      );
      if (stdout && stdout.length > 0) {
        const gz = zlib.gzipSync(Buffer.from(stdout, "utf8"));
        const dbFileName = `db_${stamp}.sql.gz`;
        await fsp.writeFile(path.join(backupDir, dbFileName), gz, {
          mode: 0o600,
        });
        createdFiles.push(dbFileName);
        pgDumpSuccess = true;
        mode = "PG_DUMP";
      }
    } catch {
      pgDumpSuccess = false;
    }
  }

  // Fallback: pure Node.js compressed Prisma snapshot (guaranteed even if pg_dump isn't installed)
  if (!pgDumpSuccess) {
    try {
      const [
        users,
        ues,
        ueRoles,
        chapters,
        documents,
        studyArtifacts,
        communityQuizzes,
        whiteboards,
        channels,
        systemSettings,
      ] = await Promise.all([
        prisma.user.findMany({
          select: {
            id: true,
            name: true,
            email: true,
            globalRole: true,
            classLevel: true,
            isApproved: true,
            currentStreak: true,
            bestStreak: true,
            totalRevisionPoints: true,
            createdAt: true,
          },
        }),
        prisma.uE.findMany(),
        prisma.uERole.findMany(),
        prisma.chapter.findMany(),
        prisma.document.findMany(),
        prisma.studyArtifact.findMany(),
        prisma.communityQuiz.findMany(),
        prisma.whiteboard.findMany(),
        prisma.channel.findMany(),
        prisma.$queryRaw<Array<{ key: string; value: string }>>`
          SELECT "key", "value" FROM "SystemSetting"
        `.catch(() => []),
      ]);

      const snapshot = {
        exportedAt: new Date().toISOString(),
        users,
        ues,
        ueRoles,
        chapters,
        documents,
        studyArtifacts,
        communityQuizzes,
        whiteboards,
        channels,
        systemSettings,
      };
      const gz = zlib.gzipSync(Buffer.from(JSON.stringify(snapshot), "utf8"));
      const jsonFileName = `db_${stamp}.json.gz`;
      await fsp.writeFile(path.join(backupDir, jsonFileName), gz, {
        mode: 0o600,
      });
      createdFiles.push(jsonFileName);
      mode = "PRISMA_JSON";
      warning =
        "pg_dump indisponible côté Node : sauvegarde JSON compressée générée via Prisma.";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      void logSystemError({
        source: "BACKUP",
        message: "Échec de la sauvegarde de la base de données.",
        detail: msg,
      });
      throw err;
    }
  }

  // 2. Archive PDF uploads if directory exists and tar binary is available
  const storageRoot = path.join(process.cwd(), "storage");
  const uploadsDir = path.join(storageRoot, "uploads");
  try {
    const upStat = await fsp.stat(uploadsDir);
    if (upStat.isDirectory()) {
      const uploadsArchive = `uploads_${stamp}.tar.gz`;
      await execFileAsync(
        "tar",
        ["-czf", path.join(backupDir, uploadsArchive), "-C", storageRoot, "uploads"],
        { timeout: 120_000 }
      );
      createdFiles.push(uploadsArchive);
    }
  } catch {
    // Non-fatal if uploads dir is empty or tar missing (e.g. dev)
  }

  // 3. Prune backups older than 7 days
  try {
    const cutoffMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const allFiles = await fsp.readdir(backupDir);
    for (const f of allFiles) {
      const fp = path.join(backupDir, f);
      const st = await fsp.stat(fp).catch(() => null);
      if (st && st.isFile() && st.mtimeMs < cutoffMs) {
        await fsp.unlink(fp).catch(() => null);
      }
    }
  } catch {
    // Ignore cleanup errors
  }

  const status = await getBackupStatus();
  return {
    ok: createdFiles.length > 0,
    mode,
    createdFiles,
    status,
    ...(warning ? { warning } : {}),
  };
}
