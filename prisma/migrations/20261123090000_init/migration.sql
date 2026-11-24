-- CreateExtension
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- CreateEnum
CREATE TYPE "TripState" AS ENUM ('REQUESTED', 'OFFERED', 'CONFIRMED', 'ARRIVED', 'COMPLETED', 'CANCELLED', 'NO_DRIVER');

-- CreateEnum
CREATE TYPE "DeclineReason" AS ENUM ('declined', 'timeout');

-- CreateTable
CREATE TABLE "Driver" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "plate" TEXT NOT NULL,
    "vehicle" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Booking" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "ref" TEXT NOT NULL,
    "passengerName" TEXT,
    "passengerPhone" TEXT NOT NULL,
    "pickupPoint" TEXT NOT NULL,
    "arrivalRef" TEXT,
    "pickupAt" TIMESTAMP(3) NOT NULL,
    "destination" TEXT NOT NULL,
    "partySize" INTEGER NOT NULL,
    "state" "TripState" NOT NULL DEFAULT 'REQUESTED',
    "driverId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Booking_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingDecline" (
    "bookingId" TEXT NOT NULL,
    "driverId" TEXT NOT NULL,
    "reason" "DeclineReason" NOT NULL DEFAULT 'declined',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingDecline_pkey" PRIMARY KEY ("bookingId","driverId")
);

-- CreateTable
CREATE TABLE "TripEvent" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "bookingId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TripEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "bookingId" TEXT,
    "direction" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "providerId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Driver_phone_key" ON "Driver"("phone");

-- CreateIndex
CREATE UNIQUE INDEX "Booking_ref_key" ON "Booking"("ref");

-- CreateIndex
CREATE INDEX "Booking_state_idx" ON "Booking"("state");

-- CreateIndex
CREATE INDEX "Booking_driverId_idx" ON "Booking"("driverId");

-- CreateIndex
CREATE INDEX "Booking_passengerPhone_idx" ON "Booking"("passengerPhone");

-- CreateIndex
CREATE INDEX "TripEvent_bookingId_idx" ON "TripEvent"("bookingId");

-- CreateIndex
CREATE INDEX "Message_bookingId_idx" ON "Message"("bookingId");

-- AddForeignKey
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL;

-- AddForeignKey
ALTER TABLE "BookingDecline" ADD CONSTRAINT "BookingDecline_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingDecline" ADD CONSTRAINT "BookingDecline_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "TripEvent" ADD CONSTRAINT "TripEvent_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_bookingId_fkey" FOREIGN KEY ("bookingId") REFERENCES "Booking"("id") ON DELETE SET NULL;
