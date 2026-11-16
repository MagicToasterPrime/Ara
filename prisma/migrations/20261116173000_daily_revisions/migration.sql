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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'DailyRevisionSession_userId_fkey'
  ) THEN
    ALTER TABLE "DailyRevisionSession"
      ADD CONSTRAINT "DailyRevisionSession_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
