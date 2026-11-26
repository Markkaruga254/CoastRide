-- Add ussdSessionId column to Booking table
ALTER TABLE "Booking" ADD COLUMN "ussdSessionId" TEXT;
CREATE UNIQUE INDEX "Booking_ussdSessionId_key" ON "Booking"("ussdSessionId");