CREATE TYPE "PaymentProvider" AS ENUM ('MOCK');
CREATE TYPE "PaymentStatus" AS ENUM ('SUCCEEDED', 'FAILED');
CREATE TYPE "MockPaymentOutcome" AS ENUM ('SUCCEED', 'FAIL');

CREATE TABLE "payment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "booking_id" UUID NOT NULL,
  "payment_number" VARCHAR(23) NOT NULL,
  "provider" "PaymentProvider" NOT NULL DEFAULT 'MOCK',
  "status" "PaymentStatus" NOT NULL,
  "requested_outcome" "MockPaymentOutcome" NOT NULL,
  "amount_cents" INTEGER NOT NULL,
  "currency" CHAR(3) NOT NULL DEFAULT 'CNY',
  "idempotency_key" VARCHAR(80) NOT NULL,
  "processed_at" TIMESTAMPTZ(3) NOT NULL,
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "payment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "payment_payment_number_key" UNIQUE ("payment_number"),
  CONSTRAINT "payment_booking_id_idempotency_key_key"
    UNIQUE ("booking_id", "idempotency_key"),
  CONSTRAINT "payment_number_check"
    CHECK ("payment_number" ~ '^SFP[0-9]{8}[A-F0-9]{12}$'),
  CONSTRAINT "payment_idempotency_key_check"
    CHECK ("idempotency_key" ~ '^[A-Za-z0-9._~-]{32,80}$'),
  CONSTRAINT "payment_amount_check" CHECK ("amount_cents" >= 0),
  CONSTRAINT "payment_currency_check" CHECK ("currency" = 'CNY'),
  CONSTRAINT "payment_outcome_status_check" CHECK (
    ("requested_outcome" = 'SUCCEED' AND "status" = 'SUCCEEDED')
    OR ("requested_outcome" = 'FAIL' AND "status" = 'FAILED')
  )
);

CREATE UNIQUE INDEX "payment_booking_success_key"
ON "payment"("booking_id")
WHERE "status" = 'SUCCEEDED';

CREATE INDEX "payment_booking_created_id_idx"
ON "payment"("booking_id", "created_at" DESC, "id" DESC);

ALTER TABLE "payment"
ADD CONSTRAINT "payment_booking_id_fkey"
FOREIGN KEY ("booking_id") REFERENCES "booking"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
