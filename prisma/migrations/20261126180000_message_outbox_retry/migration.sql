-- Add retry and lease metadata for the transactional SMS outbox.
ALTER TABLE "Message"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "lastError" TEXT,
  ADD COLUMN "lockedAt" TIMESTAMP(3);

CREATE INDEX "Message_status_nextAttemptAt_idx"
  ON "Message"("status", "nextAttemptAt");
