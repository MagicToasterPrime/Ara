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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'StudyArtifact_userId_fkey'
  ) THEN
    ALTER TABLE "StudyArtifact"
      ADD CONSTRAINT "StudyArtifact_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'StudyArtifact_ueId_fkey'
  ) THEN
    ALTER TABLE "StudyArtifact"
      ADD CONSTRAINT "StudyArtifact_ueId_fkey"
      FOREIGN KEY ("ueId") REFERENCES "UE"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
