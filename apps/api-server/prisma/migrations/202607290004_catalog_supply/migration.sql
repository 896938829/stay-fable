CREATE TYPE "PropertyType" AS ENUM ('HOTEL', 'HOMESTAY', 'FARM_STAY');
CREATE TYPE "PropertyStatus" AS ENUM ('OPEN', 'CLOSED');
CREATE TYPE "RoomTypeStatus" AS ENUM ('ON_SALE', 'OFF_SALE');
CREATE TYPE "PropertyMediaType" AS ENUM ('IMAGE');

CREATE TABLE "property" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "city_id" UUID NOT NULL,
    "type" "PropertyType" NOT NULL,
    "name_zh" VARCHAR(120) NOT NULL,
    "address_zh" VARCHAR(240) NOT NULL,
    "location" geography(Point,4326) NOT NULL,
    "short_description_zh" VARCHAR(240) NOT NULL,
    "description_zh" VARCHAR(2000) NOT NULL,
    "policies_zh" VARCHAR(2000) NOT NULL,
    "cover_url" VARCHAR(500) NOT NULL,
    "status" "PropertyStatus" NOT NULL DEFAULT 'OPEN',
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "property_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "property_display_order_check" CHECK ("display_order" >= 0)
);

CREATE TABLE "property_media" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "property_id" UUID NOT NULL,
    "type" "PropertyMediaType" NOT NULL DEFAULT 'IMAGE',
    "url" VARCHAR(500) NOT NULL,
    "alt_zh" VARCHAR(120) NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "property_media_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "property_media_display_order_check" CHECK ("display_order" >= 0)
);

CREATE TABLE "facility" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(64) NOT NULL,
    "name_zh" VARCHAR(80) NOT NULL,
    "display_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "facility_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "facility_display_order_check" CHECK ("display_order" >= 0)
);

CREATE TABLE "property_facility" (
    "property_id" UUID NOT NULL,
    "facility_id" UUID NOT NULL,

    CONSTRAINT "property_facility_pkey" PRIMARY KEY ("property_id", "facility_id")
);

CREATE TABLE "room_type" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "property_id" UUID NOT NULL,
    "name_zh" VARCHAR(120) NOT NULL,
    "bed_type_zh" VARCHAR(120) NOT NULL,
    "area_sqm" DECIMAL(5,2) NOT NULL,
    "max_guests" INTEGER NOT NULL,
    "cover_url" VARCHAR(500) NOT NULL,
    "description_zh" VARCHAR(2000) NOT NULL,
    "booking_policy_zh" VARCHAR(2000) NOT NULL,
    "status" "RoomTypeStatus" NOT NULL DEFAULT 'ON_SALE',
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "room_type_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "room_type_area_check" CHECK ("area_sqm" > 0),
    CONSTRAINT "room_type_guests_check" CHECK ("max_guests" BETWEEN 1 AND 10),
    CONSTRAINT "room_type_display_order_check" CHECK ("display_order" >= 0)
);

CREATE TABLE "daily_price" (
    "room_type_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "sale_price_cents" INTEGER NOT NULL,
    "rack_price_cents" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "daily_price_pkey" PRIMARY KEY ("room_type_id", "business_date"),
    CONSTRAINT "daily_price_sale_check" CHECK ("sale_price_cents" >= 0),
    CONSTRAINT "daily_price_rack_check" CHECK ("rack_price_cents" >= "sale_price_cents")
);

CREATE TABLE "daily_inventory" (
    "room_type_id" UUID NOT NULL,
    "business_date" DATE NOT NULL,
    "total_inventory" INTEGER NOT NULL,
    "held_inventory" INTEGER NOT NULL DEFAULT 0,
    "sold_inventory" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "daily_inventory_pkey" PRIMARY KEY ("room_type_id", "business_date"),
    CONSTRAINT "daily_inventory_nonnegative_check"
        CHECK (
            "total_inventory" >= 0
            AND "held_inventory" >= 0
            AND "sold_inventory" >= 0
            AND "version" >= 0
        ),
    CONSTRAINT "daily_inventory_available_check"
        CHECK (
            "total_inventory" < 0
            OR "held_inventory" < 0
            OR "sold_inventory" < 0
            OR "held_inventory" + "sold_inventory" <= "total_inventory"
        )
);

CREATE UNIQUE INDEX "property_city_id_name_zh_key"
ON "property"("city_id", "name_zh");

CREATE INDEX "property_city_status_type_order_id_idx"
ON "property"("city_id", "status", "type", "display_order", "id");

CREATE INDEX "property_location_gix" ON "property" USING GIST ("location");

CREATE UNIQUE INDEX "property_media_property_id_display_order_key"
ON "property_media"("property_id", "display_order");

CREATE UNIQUE INDEX "facility_code_key" ON "facility"("code");

CREATE INDEX "property_facility_facility_id_idx" ON "property_facility"("facility_id");

CREATE UNIQUE INDEX "room_type_property_id_name_zh_key"
ON "room_type"("property_id", "name_zh");

CREATE INDEX "room_type_property_status_capacity_order_id_idx"
ON "room_type"("property_id", "status", "max_guests", "display_order", "id");

CREATE INDEX "daily_price_date_room_idx"
ON "daily_price"("business_date", "room_type_id");

CREATE INDEX "daily_inventory_date_room_idx"
ON "daily_inventory"("business_date", "room_type_id");

ALTER TABLE "property"
ADD CONSTRAINT "property_city_id_fkey"
FOREIGN KEY ("city_id") REFERENCES "city"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "property_media"
ADD CONSTRAINT "property_media_property_id_fkey"
FOREIGN KEY ("property_id") REFERENCES "property"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "property_facility"
ADD CONSTRAINT "property_facility_property_id_fkey"
FOREIGN KEY ("property_id") REFERENCES "property"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "property_facility"
ADD CONSTRAINT "property_facility_facility_id_fkey"
FOREIGN KEY ("facility_id") REFERENCES "facility"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "room_type"
ADD CONSTRAINT "room_type_property_id_fkey"
FOREIGN KEY ("property_id") REFERENCES "property"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "daily_price"
ADD CONSTRAINT "daily_price_room_type_id_fkey"
FOREIGN KEY ("room_type_id") REFERENCES "room_type"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "daily_inventory"
ADD CONSTRAINT "daily_inventory_room_type_id_fkey"
FOREIGN KEY ("room_type_id") REFERENCES "room_type"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
