CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "IdentityProvider" AS ENUM ('WECHAT');

CREATE TABLE "user" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "user_identity" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "provider" "IdentityProvider" NOT NULL,
    "provider_subject" VARCHAR(160) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_identity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "city" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" VARCHAR(32) NOT NULL,
    "name_zh" VARCHAR(80) NOT NULL,
    "center" geography(Point,4326) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "display_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "city_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "user_identity_provider_subject_key"
ON "user_identity"("provider", "provider_subject");

CREATE INDEX "user_identity_user_id_idx" ON "user_identity"("user_id");

CREATE UNIQUE INDEX "city_code_key" ON "city"("code");

CREATE INDEX "city_enabled_display_order_idx" ON "city"("enabled", "display_order");

CREATE INDEX "city_center_gix" ON "city" USING GIST ("center");

ALTER TABLE "user_identity"
ADD CONSTRAINT "user_identity_user_id_fkey"
FOREIGN KEY ("user_id") REFERENCES "user"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
