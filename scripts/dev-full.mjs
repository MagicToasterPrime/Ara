#!/usr/bin/env node
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const ROOT = process.cwd();
const IS_WIN = process.platform === "win32";
const NPX_BIN = IS_WIN ? "npx.cmd" : "npx";

function log(msg) {
  console.log(`[ARA dev:full] ${msg}`);
}

function checkPortOpen(host, port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };

    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function ensureEnvironment() {
  const envPath = path.join(ROOT, ".env");
  const examplePath = path.join(ROOT, ".env.example");
  if (!fs.existsSync(envPath) && fs.existsSync(examplePath)) {
    await fsp.copyFile(examplePath, envPath);
    log("Fichier .env créé depuis .env.example.");
  }

  const uploadDir = path.join(ROOT, "storage", "uploads");
  await fsp.mkdir(uploadDir, { recursive: true });
}

function tryDockerComposeUp() {
  const versionCheck = spawnSync("docker", ["compose", "version"], {
    stdio: "ignore",
    shell: IS_WIN,
  });
  if (versionCheck.status !== 0) {
    return false;
  }

  log("Démarrage du conteneur PostgreSQL + pgvector via Docker Compose...");
  const up = spawnSync("docker", ["compose", "up", "-d"], {
    stdio: "inherit",
    shell: IS_WIN,
  });
  return up.status === 0;
}

async function waitForPostgres(host, port, retries = 30) {
  for (let i = 0; i < retries; i += 1) {
    if (await checkPortOpen(host, port, 800)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

async function startEmbeddedPgvector() {
  log("Docker indisponible : démarrage de PostgreSQL 16 + pgvector embarqué (PGlite) sur 127.0.0.1:5432...");
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite-pgvector");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");

  const pgDataDir = path.join(ROOT, "storage", "pgdata");
  await fsp.mkdir(pgDataDir, { recursive: true });

  const db = await PGlite.create({
    dataDir: pgDataDir,
    extensions: { vector },
  });

  await db.exec("CREATE EXTENSION IF NOT EXISTS vector;");

  const check = await db.query(`SELECT to_regclass('public."User"') AS reg;`);
  if (!check.rows?.[0]?.reg) {
    const migrationPath = path.join(
      ROOT,
      "prisma",
      "migrations",
      "20261116000000_init",
      "migration.sql"
    );
    const sql = await fsp.readFile(migrationPath, "utf8");
    await db.exec(sql);
    log("Migration SQL initiale (PostgreSQL + pgvector) appliquée sur la base embarquée.");
  }

  await db.exec(`
    ALTER TABLE "Whiteboard" ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE "Whiteboard" ADD COLUMN IF NOT EXISTS "isIntegrated" BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "revisionEnabled" BOOLEAN NOT NULL DEFAULT false;
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "currentStreak" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "bestStreak" INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "lastRevisionDate" TEXT;
    ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "totalRevisionPoints" INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE IF NOT EXISTS "DailyRevisionSession" (
      "id" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "dateKey" TEXT NOT NULL,
      "questionsJson" TEXT NOT NULL,
      "answersJson" TEXT NOT NULL DEFAULT '{}',
      "score" INTEGER NOT NULL DEFAULT 0,
      "totalQuestions" INTEGER NOT NULL DEFAULT 0,
      "completed" BOOLEAN NOT NULL DEFAULT false,
      "completedAt" TIMESTAMP(3),
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "DailyRevisionSession_pkey" PRIMARY KEY ("id")
    );
    CREATE UNIQUE INDEX IF NOT EXISTS "DailyRevisionSession_userId_dateKey_key" ON "DailyRevisionSession"("userId", "dateKey");
    CREATE INDEX IF NOT EXISTS "DailyRevisionSession_userId_createdAt_idx" ON "DailyRevisionSession"("userId", "createdAt");
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
    CREATE INDEX IF NOT EXISTS "StudyArtifact_userId_createdAt_idx" ON "StudyArtifact"("userId", "createdAt");
    CREATE INDEX IF NOT EXISTS "StudyArtifact_ueId_createdAt_idx" ON "StudyArtifact"("ueId", "createdAt");
    CREATE TABLE IF NOT EXISTS "CommunityQuiz" (
      "id" TEXT NOT NULL,
      "authorId" TEXT NOT NULL,
      "ueId" TEXT,
      "title" TEXT NOT NULL,
      "description" TEXT NOT NULL DEFAULT '',
      "questionsJson" TEXT NOT NULL,
      "isPublic" BOOLEAN NOT NULL DEFAULT true,
      "isPinned" BOOLEAN NOT NULL DEFAULT false,
      "attemptsCount" INTEGER NOT NULL DEFAULT 0,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT "CommunityQuiz_pkey" PRIMARY KEY ("id")
    );
    CREATE TABLE IF NOT EXISTS "CommunityQuizUpvote" (
      "userId" TEXT NOT NULL,
      "quizId" TEXT NOT NULL,
      CONSTRAINT "CommunityQuizUpvote_pkey" PRIMARY KEY ("userId", "quizId")
    );
    CREATE INDEX IF NOT EXISTS "CommunityQuiz_ueId_createdAt_idx" ON "CommunityQuiz"("ueId", "createdAt");
    CREATE INDEX IF NOT EXISTS "CommunityQuiz_authorId_createdAt_idx" ON "CommunityQuiz"("authorId", "createdAt");
  `);

  const socketServer = new PGLiteSocketServer({
    db,
    host: "127.0.0.1",
    port: 5432,
    maxConnections: 10,
  });

  await socketServer.start();
  log("PostgreSQL embarqué + pgvector prêt sur 127.0.0.1:5432.");

  return async () => {
    await socketServer.stop();
    await db.close();
  };
}

function runPrismaGenerate() {
  log("Génération du client Prisma...");
  const gen = spawnSync(NPX_BIN, ["prisma", "generate"], {
    stdio: "inherit",
    shell: IS_WIN,
  });
  if (gen.status !== 0) {
    throw new Error("Échec de `prisma generate`.");
  }
}

function runPrismaMigrate() {
  log("Application des migrations Prisma sur PostgreSQL...");
  const migrate = spawnSync(NPX_BIN, ["prisma", "migrate", "deploy"], {
    stdio: "inherit",
    shell: IS_WIN,
  });

  if (migrate.status !== 0) {
    log("Application du schéma via `prisma db push`...");
    const push = spawnSync(NPX_BIN, ["prisma", "db", "push"], {
      stdio: "inherit",
      shell: IS_WIN,
    });
    if (push.status !== 0) {
      throw new Error("Échec de la synchronisation Prisma avec la base de données.");
    }
  }
}

async function main() {
  await ensureEnvironment();
  runPrismaGenerate();

  let stopEmbedded = null;
  const alreadyRunning = await checkPortOpen("127.0.0.1", 5432);

  if (alreadyRunning) {
    log("Base PostgreSQL détectée sur 127.0.0.1:5432.");
  } else {
    const dockerStarted = tryDockerComposeUp();
    if (dockerStarted) {
      const ready = await waitForPostgres("127.0.0.1", 5432, 30);
      if (!ready) {
        throw new Error("PostgreSQL Docker n'a pas répondu à temps sur le port 5432.");
      }
      log("Conteneur PostgreSQL + pgvector prêt.");
    } else {
      stopEmbedded = await startEmbeddedPgvector();
    }
  }

  if (!stopEmbedded) {
    runPrismaMigrate();
  }

  log("Lancement du serveur unifié Ara (Next.js + Socket.io) sur http://localhost:3000 ...");
  const tsxCli = path.join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const serverProc = spawn(process.execPath, [tsxCli, "server.ts"], {
    stdio: "inherit",
    env: process.env,
  });

  const shutdown = async () => {
    serverProc.kill("SIGTERM");
    if (stopEmbedded) {
      await stopEmbedded();
    }
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  serverProc.on("exit", async (code) => {
    if (stopEmbedded) {
      await stopEmbedded();
    }
    process.exit(code ?? 0);
  });
}

main().catch((err) => {
  console.error("[ARA dev:full] Erreur fatale:", err);
  process.exit(1);
});
