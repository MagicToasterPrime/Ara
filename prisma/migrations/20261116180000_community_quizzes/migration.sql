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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CommunityQuiz_authorId_fkey'
  ) THEN
    ALTER TABLE "CommunityQuiz"
      ADD CONSTRAINT "CommunityQuiz_authorId_fkey"
      FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CommunityQuiz_ueId_fkey'
  ) THEN
    ALTER TABLE "CommunityQuiz"
      ADD CONSTRAINT "CommunityQuiz_ueId_fkey"
      FOREIGN KEY ("ueId") REFERENCES "UE"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CommunityQuizUpvote_userId_fkey'
  ) THEN
    ALTER TABLE "CommunityQuizUpvote_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'CommunityQuizUpvote_quizId_fkey'
  ) THEN
    ALTER TABLE "CommunityQuizUpvote_quizId_fkey" FOREIGN KEY ("quizId") REFERENCES "CommunityQuiz"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
