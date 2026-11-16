import { prisma } from "@/lib/prisma";

let quizSchemaEnsured = false;

export async function ensureCommunityQuizSchema() {
  if (quizSchemaEnsured) return;
  try {
    await prisma.$executeRawUnsafe(`
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
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TABLE IF NOT EXISTS "CommunityQuizUpvote" (
        "userId" TEXT NOT NULL,
        "quizId" TEXT NOT NULL,
        CONSTRAINT "CommunityQuizUpvote_pkey" PRIMARY KEY ("userId", "quizId")
      );
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "CommunityQuiz_ueId_createdAt_idx"
      ON "CommunityQuiz"("ueId", "createdAt");
    `);
    await prisma.$executeRawUnsafe(`
      CREATE INDEX IF NOT EXISTS "CommunityQuiz_authorId_createdAt_idx"
      ON "CommunityQuiz"("authorId", "createdAt");
    `);
    quizSchemaEnsured = true;
  } catch (err) {
    console.warn("[CommunityQuiz] Schema check warning:", err);
  }
}
