CREATE TYPE "BookingStatus" AS ENUM (
    'PENDING_PAYMENT',
    'PAID',
    'CONFIRMED',
    'CANCELLED',
    'CLOSED'
);

CREATE TYPE "InventoryHoldStatus" AS ENUM (
    'HELD',
    'CONSUMED',
    'RELEASED'
);

CREATE TYPE "BookingActorType" AS ENUM (
    'USER',
    'SYSTEM'
);

CREATE TABLE "quote" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "checkin_date" DATE NOT NULL,
    "checkout_date" DATE NOT NULL,
    "guests" INTEGER NOT NULL,
    "nightly_prices" JSONB NOT NULL,
    "property_snapshot" JSONB NOT NULL,
    "room_type_snapshot" JSONB NOT NULL,
    "booking_policy_snapshot" VARCHAR(2000) NOT NULL,
    "total_price_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'CNY',
    "fingerprint" CHAR(64) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "quote_dates_check" CHECK ("checkout_date" > "checkin_date"),
    CONSTRAINT "quote_guests_check" CHECK ("guests" BETWEEN 1 AND 10),
    CONSTRAINT "quote_total_price_check" CHECK ("total_price_cents" >= 0),
    CONSTRAINT "quote_currency_check" CHECK ("currency" = 'CNY'),
    CONSTRAINT "quote_fingerprint_check" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "quote_expires_check" CHECK ("expires_at" > "created_at")
);

CREATE TABLE "booking" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "property_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "booking_number" VARCHAR(22) NOT NULL,
    "status" "BookingStatus" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "checkin_date" DATE NOT NULL,
    "checkout_date" DATE NOT NULL,
    "guests" INTEGER NOT NULL,
    "property_snapshot" JSONB NOT NULL,
    "room_type_snapshot" JSONB NOT NULL,
    "nightly_prices" JSONB NOT NULL,
    "booking_policy_snapshot" VARCHAR(2000) NOT NULL,
    "total_price_cents" INTEGER NOT NULL,
    "currency" CHAR(3) NOT NULL DEFAULT 'CNY',
    "idempotency_key" VARCHAR(80) NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "booking_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "booking_quote_id_key" UNIQUE ("quote_id"),
    CONSTRAINT "booking_booking_number_key" UNIQUE ("booking_number"),
    CONSTRAINT "booking_user_id_idempotency_key_key" UNIQUE ("user_id", "idempotency_key"),
    CONSTRAINT "booking_dates_check" CHECK ("checkout_date" > "checkin_date"),
    CONSTRAINT "booking_guests_check" CHECK ("guests" BETWEEN 1 AND 10),
    CONSTRAINT "booking_total_price_check" CHECK ("total_price_cents" >= 0),
    CONSTRAINT "booking_currency_check" CHECK ("currency" = 'CNY'),
    CONSTRAINT "booking_number_check"
        CHECK ("booking_number" ~ '^SF[0-9]{8}[A-F0-9]{12}$'),
    CONSTRAINT "booking_idempotency_key_check"
        CHECK ("idempotency_key" ~ '^[A-Za-z0-9._~-]{32,80}$'),
    CONSTRAINT "booking_expires_check" CHECK ("expires_at" > "created_at")
);

CREATE TABLE "inventory_hold" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "booking_id" UUID NOT NULL,
    "room_type_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "status" "InventoryHoldStatus" NOT NULL DEFAULT 'HELD',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "inventory_hold_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inventory_hold_booking_id_business_date_key"
        UNIQUE ("booking_id", "business_date"),
    CONSTRAINT "inventory_hold_expires_check" CHECK ("expires_at" > "created_at")
);

CREATE TABLE "booking_status_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "booking_id" UUID NOT NULL,
    "from_status" "BookingStatus",
    "to_status" "BookingStatus" NOT NULL,
    "reason" VARCHAR(64) NOT NULL,
    "actor_type" "BookingActorType" NOT NULL,
    "actor_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "booking_status_history_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "booking_status_history_actor_check"
        CHECK (
            ("actor_type" = 'USER' AND "actor_user_id" IS NOT NULL)
            OR ("actor_type" = 'SYSTEM' AND "actor_user_id" IS NULL)
        )
);

CREATE INDEX "quote_user_expires_idx"
ON "quote"("user_id", "expires_at");

CREATE INDEX "quote_room_created_idx"
ON "quote"("room_type_id", "created_at");

CREATE INDEX "booking_user_created_id_idx"
ON "booking"("user_id", "created_at", "id");

CREATE INDEX "booking_status_expires_id_idx"
ON "booking"("status", "expires_at", "id");

CREATE INDEX "inventory_hold_status_expires_id_idx"
ON "inventory_hold"("status", "expires_at", "id");

CREATE INDEX "inventory_hold_room_date_idx"
ON "inventory_hold"("room_type_id", "business_date");

CREATE INDEX "booking_status_history_booking_created_id_idx"
ON "booking_status_history"("booking_id", "created_at", "id");

CREATE INDEX "booking_status_history_actor_user_id_idx"
ON "booking_status_history"("actor_user_id");

ALTER TABLE "quote"
ADD CONSTRAINT "quote_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "user"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "quote"
ADD CONSTRAINT "quote_property_id_fkey"
FOREIGN KEY ("property_id") REFERENCES "property"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "quote"
ADD CONSTRAINT "quote_room_type_id_fkey"
FOREIGN KEY ("room_type_id") REFERENCES "room_type"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "booking"
ADD CONSTRAINT "booking_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "user"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "booking"
ADD CONSTRAINT "booking_quote_id_fkey"
FOREIGN KEY ("quote_id") REFERENCES "quote"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "booking"
ADD CONSTRAINT "booking_property_id_fkey"
FOREIGN KEY ("property_id") REFERENCES "property"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "booking"
ADD CONSTRAINT "booking_room_type_id_fkey"
FOREIGN KEY ("room_type_id") REFERENCES "room_type"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_hold"
ADD CONSTRAINT "inventory_hold_booking_id_fkey"
FOREIGN KEY ("booking_id") REFERENCES "booking"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_hold"
ADD CONSTRAINT "inventory_hold_room_type_id_fkey"
FOREIGN KEY ("room_type_id") REFERENCES "room_type"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "booking_status_history"
ADD CONSTRAINT "booking_status_history_booking_id_fkey"
FOREIGN KEY ("booking_id") REFERENCES "booking"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "booking_status_history"
ADD CONSTRAINT "booking_status_history_actor_user_id_fkey"
FOREIGN KEY ("actor_user_id") REFERENCES "user"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "daily_inventory"
DROP CONSTRAINT "daily_inventory_available_check";

ALTER TABLE "daily_inventory"
ADD CONSTRAINT "daily_inventory_capacity_check"
CHECK (
    "total_inventory" < 0
    OR "held_inventory" < 0
    OR "sold_inventory" < 0
    OR (
        "total_inventory" >= 0
        AND "held_inventory" >= 0
        AND "sold_inventory" >= 0
        AND "held_inventory" + "sold_inventory" <= "total_inventory"
    )
) NOT VALID;

ALTER TABLE "daily_inventory"
VALIDATE CONSTRAINT "daily_inventory_capacity_check";
