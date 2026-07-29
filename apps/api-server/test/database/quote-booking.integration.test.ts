import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { requireSafeDatabaseIntegrationUrl } from "./database-integration-guard.js";

const runDatabaseIntegration = process.env.RUN_DATABASE_INTEGRATION === "true";
const describeDatabase = runDatabaseIntegration ? describe : describe.skip;
const suiteName = runDatabaseIntegration
  ? "quote booking PostgreSQL persistence contract"
  : "quote booking PostgreSQL persistence contract (set RUN_DATABASE_INTEGRATION=true to run)";
const targetMigration = fileURLToPath(
  new URL("../../prisma/migrations/202607300001_quote_booking_hold/migration.sql", import.meta.url),
);

const quoteGeneratedTestSchema = (schemaName: string): string => {
  if (!/^quote_booking_test_[0-9a-f]{16}$/.test(schemaName)) {
    throw new Error("Invalid generated quote booking test schema");
  }
  return `"${schemaName}"`;
};

describeDatabase(suiteName, () => {
  let client: PoolClient | undefined;
  let pool: Pool | undefined;
  let quotedSchema: string | undefined;
  let schemaName: string | undefined;
  let migrationApplied: Promise<void> | undefined;

  const database = (): PoolClient => {
    if (client === undefined) {
      throw new Error("Quote booking database client was not initialized");
    }
    return client;
  };

  const createBaselineFixtures = async (): Promise<void> => {
    const db = database();
    if (quotedSchema === undefined) {
      throw new Error("Quote booking test schema was not initialized");
    }

    for (const table of [
      "city",
      "user",
      "property",
      "room_type",
      "daily_price",
      "daily_inventory",
    ]) {
      await db.query(
        `CREATE TABLE ${quotedSchema}."${table}" (LIKE public."${table}" INCLUDING ALL)`,
      );
    }

    const city = await db.query<{ id: string }>(`
      INSERT INTO city (code, name_zh, center, updated_at)
      VALUES ('quote-test', '报价测试城市', ST_SetSRID(ST_MakePoint(120, 30), 4326)::geography, CURRENT_TIMESTAMP)
      RETURNING id::text
    `);
    await db.query<{ id: string }>(
      'INSERT INTO "user" (updated_at) VALUES (CURRENT_TIMESTAMP) RETURNING id::text',
    );
    const property = await db.query<{ id: string }>(
      `
      INSERT INTO property (
        city_id, type, name_zh, address_zh, location, short_description_zh,
        description_zh, policies_zh, cover_url, updated_at
      )
      VALUES (
        $1::uuid, 'HOTEL', '报价测试酒店', '测试地址',
        ST_SetSRID(ST_MakePoint(120, 30), 4326)::geography, '测试简介',
        '测试描述', '测试政策', 'https://example.test/property.jpg', CURRENT_TIMESTAMP
      )
      RETURNING id::text
    `,
      [city.rows[0]?.id],
    );
    const room = await db.query<{ id: string }>(
      `
      INSERT INTO room_type (
        property_id, name_zh, bed_type_zh, area_sqm, max_guests, cover_url,
        description_zh, booking_policy_zh, updated_at
      )
      VALUES (
        $1::uuid, '报价测试房型', '大床', 30.00, 4, 'https://example.test/room.jpg',
        '测试房型描述', '测试预订政策', CURRENT_TIMESTAMP
      )
      RETURNING id::text
    `,
      [property.rows[0]?.id],
    );
    const roomId = room.rows[0]?.id;
    await db.query(
      `INSERT INTO daily_price (room_type_id, business_date, sale_price_cents, rack_price_cents, updated_at)
       VALUES ($1::uuid, DATE '2026-08-01', 15000, 18000, CURRENT_TIMESTAMP)`,
      [roomId],
    );
    await db.query(
      `INSERT INTO daily_inventory (room_type_id, business_date, total_inventory, held_inventory, sold_inventory, updated_at)
       VALUES ($1::uuid, DATE '2026-08-01', 3, 0, 0, CURRENT_TIMESTAMP)`,
      [roomId],
    );
  };

  const readTargetMigration = async (): Promise<string> => {
    const migrationSql = await readFile(targetMigration, "utf8");
    expect(migrationSql).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE|DROP\s+TABLE|down)\b/i);
    expect(migrationSql).toMatch(
      /ALTER\s+TABLE\s+"daily_inventory"\s+DROP\s+CONSTRAINT\s+"daily_inventory_available_check"/i,
    );
    return migrationSql;
  };

  const applyTargetMigration = async (): Promise<void> => {
    migrationApplied ??= (async () => {
      await database().query(await readTargetMigration());
    })();
    return migrationApplied;
  };

  const expectCheckViolation = async (sql: string, values: unknown[], constraint?: string) => {
    await database().query("BEGIN");
    try {
      await database().query("SAVEPOINT contract_violation");
      await expect(database().query(sql, values)).rejects.toMatchObject({
        code: "23514",
        ...(constraint === undefined ? {} : { constraint }),
      });
      await database().query("ROLLBACK TO SAVEPOINT contract_violation");
    } finally {
      await database().query("ROLLBACK");
    }
  };

  beforeAll(async () => {
    const connectionString = requireSafeDatabaseIntegrationUrl(process.env.DATABASE_URL);
    pool = new Pool({ connectionString });
    client = await pool.connect();
    schemaName = `quote_booking_test_${randomBytes(8).toString("hex")}`;
    quotedSchema = quoteGeneratedTestSchema(schemaName);
    await client.query(`CREATE SCHEMA ${quotedSchema}`);
    await client.query(`SET search_path TO ${quotedSchema}, public`);
    await createBaselineFixtures();
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    try {
      if (quotedSchema !== undefined && pool !== undefined) {
        await pool.query(`DROP SCHEMA ${quotedSchema} CASCADE`);
      }
    } catch (error) {
      cleanupErrors.push(error);
    } finally {
      client?.release();
      try {
        await pool?.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(cleanupErrors, "quote booking contract cleanup failed");
    }
  });

  test("the target migration is present and executes in an isolated schema", async () => {
    await applyTargetMigration();
  }, 25_000);

  test("target relations, enums, and key columns are isolated in the generated schema", async () => {
    await applyTargetMigration();
    const schema = schemaName;
    expect(schema).toMatch(/^quote_booking_test_[0-9a-f]{16}$/);

    const relations = await database().query<{ table_name: string }>(
      `
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = $1
        AND table_name IN ('quote', 'booking', 'inventory_hold', 'booking_status_history')
      ORDER BY table_name
    `,
      [schema],
    );
    expect(relations.rows).toEqual([
      { table_name: "booking" },
      { table_name: "booking_status_history" },
      { table_name: "inventory_hold" },
      { table_name: "quote" },
    ]);

    const enums = await database().query<{ enum_name: string; enumlabel: string }>(
      `
      SELECT type_name.typname AS enum_name, enum_value.enumlabel
      FROM pg_type type_name
      JOIN pg_namespace type_schema ON type_schema.oid = type_name.typnamespace
      JOIN pg_enum enum_value ON enum_value.enumtypid = type_name.oid
      WHERE type_schema.nspname = $1
        AND type_name.typname IN ('BookingStatus', 'InventoryHoldStatus', 'BookingActorType')
      ORDER BY type_name.typname, enum_value.enumsortorder
    `,
      [schema],
    );
    expect(enums.rows).toEqual([
      { enum_name: "BookingActorType", enumlabel: "USER" },
      { enum_name: "BookingActorType", enumlabel: "SYSTEM" },
      { enum_name: "BookingStatus", enumlabel: "PENDING_PAYMENT" },
      { enum_name: "BookingStatus", enumlabel: "PAID" },
      { enum_name: "BookingStatus", enumlabel: "CONFIRMED" },
      { enum_name: "BookingStatus", enumlabel: "CANCELLED" },
      { enum_name: "BookingStatus", enumlabel: "CLOSED" },
      { enum_name: "InventoryHoldStatus", enumlabel: "HELD" },
      { enum_name: "InventoryHoldStatus", enumlabel: "CONSUMED" },
      { enum_name: "InventoryHoldStatus", enumlabel: "RELEASED" },
    ]);

    const columns = await database().query<{
      column_default: string | null;
      column_name: string;
      data_type: string;
      is_nullable: "NO" | "YES";
      table_name: string;
      udt_name: string;
    }>(
      `
      SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_schema = $1
        AND table_name IN ('quote', 'booking', 'inventory_hold', 'booking_status_history')
      ORDER BY table_name, ordinal_position
    `,
      [schema],
    );
    const contract = Object.fromEntries(
      columns.rows.map((column) => [`${column.table_name}.${column.column_name}`, column]),
    );
    expect(contract).toMatchObject({
      "quote.id": { data_type: "uuid", udt_name: "uuid", is_nullable: "NO" },
      "quote.user_id": {
        data_type: "uuid",
        udt_name: "uuid",
        is_nullable: "NO",
        column_default: null,
      },
      "quote.nightly_prices": {
        data_type: "jsonb",
        udt_name: "jsonb",
        is_nullable: "NO",
        column_default: null,
      },
      "quote.currency": { data_type: "character", udt_name: "bpchar", is_nullable: "NO" },
      "quote.expires_at": {
        data_type: "timestamp with time zone",
        udt_name: "timestamptz",
        is_nullable: "NO",
        column_default: null,
      },
      "quote.created_at": {
        data_type: "timestamp with time zone",
        udt_name: "timestamptz",
        is_nullable: "NO",
      },
      "booking.quote_id": {
        data_type: "uuid",
        udt_name: "uuid",
        is_nullable: "NO",
        column_default: null,
      },
      "booking.status": { data_type: "USER-DEFINED", udt_name: "BookingStatus", is_nullable: "NO" },
      "booking.idempotency_key": {
        data_type: "character varying",
        udt_name: "varchar",
        is_nullable: "NO",
        column_default: null,
      },
      "booking.updated_at": {
        data_type: "timestamp with time zone",
        udt_name: "timestamptz",
        is_nullable: "NO",
        column_default: null,
      },
      "inventory_hold.status": {
        data_type: "USER-DEFINED",
        udt_name: "InventoryHoldStatus",
        is_nullable: "NO",
      },
      "inventory_hold.business_date": {
        data_type: "date",
        udt_name: "date",
        is_nullable: "NO",
        column_default: null,
      },
      "booking_status_history.from_status": {
        data_type: "USER-DEFINED",
        udt_name: "BookingStatus",
        is_nullable: "YES",
        column_default: null,
      },
      "booking_status_history.actor_type": {
        data_type: "USER-DEFINED",
        udt_name: "BookingActorType",
        is_nullable: "NO",
      },
      "booking_status_history.actor_user_id": {
        data_type: "uuid",
        udt_name: "uuid",
        is_nullable: "YES",
        column_default: null,
      },
    });
    expect(contract["quote.id"]?.column_default).toBe("gen_random_uuid()");
    expect(contract["quote.currency"]?.column_default).toBe("'CNY'::bpchar");
    expect(contract["quote.created_at"]?.column_default).toBe("CURRENT_TIMESTAMP");
    expect(contract["booking.status"]?.column_default).toBe("'PENDING_PAYMENT'::\"BookingStatus\"");
    expect(contract["inventory_hold.status"]?.column_default).toBe(
      "'HELD'::\"InventoryHoldStatus\"",
    );
  }, 25_000);

  test("primary, foreign, and unique keys use restrict deletes and cascade updates", async () => {
    await applyTargetMigration();
    const schema = schemaName;
    const primaryKeys = await database().query<{ column_names: string[]; table_name: string }>(
      `
      SELECT child.relname AS table_name, array_agg(attribute.attname ORDER BY key_column.ordinality) AS column_names
      FROM pg_constraint constraint
      JOIN pg_class child ON child.oid = constraint.conrelid
      JOIN pg_namespace child_schema ON child_schema.oid = child.relnamespace
      JOIN unnest(constraint.conkey) WITH ORDINALITY AS key_column(attribute_number, ordinality) ON true
      JOIN pg_attribute attribute ON attribute.attrelid = child.oid AND attribute.attnum = key_column.attribute_number
      WHERE constraint.contype = 'p' AND child_schema.nspname = $1
        AND child.relname IN ('quote', 'booking', 'inventory_hold', 'booking_status_history')
      GROUP BY child.relname
      ORDER BY child.relname
    `,
      [schema],
    );
    expect(primaryKeys.rows).toEqual([
      { table_name: "booking", column_names: ["id"] },
      { table_name: "booking_status_history", column_names: ["id"] },
      { table_name: "inventory_hold", column_names: ["id"] },
      { table_name: "quote", column_names: ["id"] },
    ]);

    const foreignKeys = await database().query<{
      child_column: string;
      child_table: string;
      delete_action: string;
      parent_table: string;
      update_action: string;
    }>(
      `
      SELECT child.relname AS child_table, child_attribute.attname AS child_column,
             parent.relname AS parent_table, constraint.confdeltype::text AS delete_action,
             constraint.confupdtype::text AS update_action
      FROM pg_constraint constraint
      JOIN pg_class child ON child.oid = constraint.conrelid
      JOIN pg_namespace child_schema ON child_schema.oid = child.relnamespace
      JOIN pg_class parent ON parent.oid = constraint.confrelid
      JOIN unnest(constraint.conkey) WITH ORDINALITY AS child_key(attribute_number, ordinality) ON true
      JOIN pg_attribute child_attribute ON child_attribute.attrelid = child.oid AND child_attribute.attnum = child_key.attribute_number
      WHERE constraint.contype = 'f' AND child_schema.nspname = $1
        AND child.relname IN ('quote', 'booking', 'inventory_hold', 'booking_status_history')
      ORDER BY child.relname, child_attribute.attname
    `,
      [schema],
    );
    expect(foreignKeys.rows).toEqual([
      {
        child_table: "booking",
        child_column: "property_id",
        parent_table: "property",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "booking",
        child_column: "quote_id",
        parent_table: "quote",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "booking",
        child_column: "room_type_id",
        parent_table: "room_type",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "booking",
        child_column: "user_id",
        parent_table: "user",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "booking_status_history",
        child_column: "actor_user_id",
        parent_table: "user",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "booking_status_history",
        child_column: "booking_id",
        parent_table: "booking",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "inventory_hold",
        child_column: "booking_id",
        parent_table: "booking",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "inventory_hold",
        child_column: "room_type_id",
        parent_table: "room_type",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "quote",
        child_column: "property_id",
        parent_table: "property",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "quote",
        child_column: "room_type_id",
        parent_table: "room_type",
        delete_action: "r",
        update_action: "c",
      },
      {
        child_table: "quote",
        child_column: "user_id",
        parent_table: "user",
        delete_action: "r",
        update_action: "c",
      },
    ]);

    const uniqueKeys = await database().query<{ column_names: string[]; table_name: string }>(
      `
      SELECT child.relname AS table_name, array_agg(attribute.attname ORDER BY key_column.ordinality) AS column_names
      FROM pg_constraint constraint
      JOIN pg_class child ON child.oid = constraint.conrelid
      JOIN pg_namespace child_schema ON child_schema.oid = child.relnamespace
      JOIN unnest(constraint.conkey) WITH ORDINALITY AS key_column(attribute_number, ordinality) ON true
      JOIN pg_attribute attribute ON attribute.attrelid = child.oid AND attribute.attnum = key_column.attribute_number
      WHERE constraint.contype = 'u' AND child_schema.nspname = $1
        AND child.relname IN ('booking', 'inventory_hold')
      GROUP BY child.relname, constraint.oid
      ORDER BY child.relname, column_names
    `,
      [schema],
    );
    expect(uniqueKeys.rows).toEqual([
      { table_name: "booking", column_names: ["booking_number"] },
      { table_name: "booking", column_names: ["quote_id"] },
      { table_name: "booking", column_names: ["user_id", "idempotency_key"] },
      { table_name: "inventory_hold", column_names: ["booking_id", "business_date"] },
    ]);
  }, 25_000);

  test("checks and indexes cover quote booking capacity and worker access contracts", async () => {
    await applyTargetMigration();
    const schema = schemaName;
    const checks = await database().query<{
      constraint_name: string;
      definition: string;
      table_name: string;
    }>(
      `
      SELECT child.relname AS table_name, constraint.conname AS constraint_name,
             pg_get_constraintdef(constraint.oid) AS definition
      FROM pg_constraint constraint
      JOIN pg_class child ON child.oid = constraint.conrelid
      JOIN pg_namespace child_schema ON child_schema.oid = child.relnamespace
      WHERE constraint.contype = 'c' AND child_schema.nspname = $1
        AND child.relname IN ('quote', 'booking', 'inventory_hold', 'booking_status_history', 'daily_price', 'daily_inventory')
    `,
      [schema],
    );
    const definitions = checks.rows.map(({ definition }) =>
      definition.replaceAll('"', "").replaceAll(/\s+/g, " "),
    );
    for (const fragment of [
      "checkout_date > checkin_date",
      "guests >= 1",
      "guests <= 10",
      "total_price_cents >= 0",
      "currency = 'CNY'",
      "fingerprint",
      "expires_at > created_at",
      "booking_number",
      "idempotency_key",
      "actor_type",
      "actor_user_id",
    ]) {
      expect(definitions.some((definition) => definition.includes(fragment))).toBe(true);
    }
    expect(definitions.some((definition) => /fingerprint.*\[0-9a-f\].*64/i.test(definition))).toBe(
      true,
    );
    expect(definitions.some((definition) => /booking_number.*SF.*12/i.test(definition))).toBe(true);
    expect(definitions.some((definition) => /idempotency_key.*32.*80/i.test(definition))).toBe(
      true,
    );
    expect(
      definitions.some((definition) => /actor_type.*USER.*actor_user_id.*SYSTEM/i.test(definition)),
    ).toBe(true);
    expect(
      definitions.some(
        (definition) =>
          definition.includes("total_inventory >= 0") &&
          definition.includes("held_inventory >= 0") &&
          definition.includes("sold_inventory >= 0") &&
          definition.includes("held_inventory + sold_inventory <= total_inventory"),
      ),
    ).toBe(true);
    expect(checks.rows).toContainEqual(
      expect.objectContaining({ constraint_name: "daily_inventory_capacity_check" }),
    );
    expect(checks.rows).toContainEqual(
      expect.objectContaining({ constraint_name: "daily_price_sale_check" }),
    );
    expect(checks.rows).toContainEqual(
      expect.objectContaining({ constraint_name: "daily_price_rack_check" }),
    );

    const indexes = await database().query<{ indexdef: string; indexname: string }>(
      `
      SELECT indexname, indexdef
      FROM pg_indexes
      WHERE schemaname = $1
        AND indexname IN (
          'quote_user_expires_idx', 'quote_room_created_idx',
          'booking_user_created_id_idx', 'booking_status_expires_id_idx',
          'inventory_hold_status_expires_id_idx', 'inventory_hold_room_date_idx',
          'booking_status_history_booking_created_id_idx', 'booking_status_history_actor_user_id_idx'
        )
      ORDER BY indexname
    `,
      [schema],
    );
    expect(indexes.rows.map(({ indexname }) => indexname)).toEqual([
      "booking_status_expires_id_idx",
      "booking_status_history_actor_user_id_idx",
      "booking_status_history_booking_created_id_idx",
      "booking_user_created_id_idx",
      "inventory_hold_room_date_idx",
      "inventory_hold_status_expires_id_idx",
      "quote_room_created_idx",
      "quote_user_expires_idx",
    ]);
    const indexByName = new Map(
      indexes.rows.map(({ indexdef, indexname }) => [indexname, indexdef.replaceAll('"', "")]),
    );
    expect(indexByName.get("quote_user_expires_idx")).toContain("(user_id, expires_at)");
    expect(indexByName.get("quote_room_created_idx")).toContain("(room_type_id, created_at)");
    expect(indexByName.get("booking_user_created_id_idx")).toContain("(user_id, created_at, id)");
    expect(indexByName.get("booking_status_expires_id_idx")).toContain("(status, expires_at, id)");
    expect(indexByName.get("inventory_hold_status_expires_id_idx")).toContain(
      "(status, expires_at, id)",
    );
    expect(indexByName.get("inventory_hold_room_date_idx")).toContain(
      "(room_type_id, business_date)",
    );
    expect(indexByName.get("booking_status_history_booking_created_id_idx")).toContain(
      "(booking_id, created_at, id)",
    );
    expect(indexByName.get("booking_status_history_actor_user_id_idx")).toContain(
      "(actor_user_id)",
    );
  }, 25_000);

  test("new capacity checks reject oversell and preserve copied catalog fixtures", async () => {
    await applyTargetMigration();
    const baselineCounts = await database().query<{
      daily_inventory_count: number;
      daily_price_count: number;
      property_count: number;
      room_type_count: number;
      user_count: number;
    }>(`
      SELECT
        (SELECT COUNT(*)::integer FROM "user") AS user_count,
        (SELECT COUNT(*)::integer FROM property) AS property_count,
        (SELECT COUNT(*)::integer FROM room_type) AS room_type_count,
        (SELECT COUNT(*)::integer FROM daily_price) AS daily_price_count,
        (SELECT COUNT(*)::integer FROM daily_inventory) AS daily_inventory_count
    `);
    expect(baselineCounts.rows).toEqual([
      {
        user_count: 1,
        property_count: 1,
        room_type_count: 1,
        daily_price_count: 1,
        daily_inventory_count: 1,
      },
    ]);
    const fixture = await database().query<{
      held_inventory: number;
      rack_price_cents: number;
      sale_price_cents: number;
      sold_inventory: number;
      total_inventory: number;
    }>(`
      SELECT inventory.total_inventory, inventory.held_inventory, inventory.sold_inventory,
             price.sale_price_cents, price.rack_price_cents
      FROM daily_inventory inventory
      JOIN daily_price price USING (room_type_id, business_date)
      WHERE inventory.business_date = DATE '2026-08-01'
    `);
    expect(fixture.rows).toEqual([
      {
        total_inventory: 3,
        held_inventory: 0,
        sold_inventory: 0,
        sale_price_cents: 15000,
        rack_price_cents: 18000,
      },
    ]);
    const oldCapacity = await database().query<{ conname: string }>(
      `
      SELECT conname FROM pg_constraint
      WHERE connamespace = $1::regnamespace AND conname = 'daily_inventory_available_check'
    `,
      [schemaName],
    );
    expect(oldCapacity.rows).toEqual([]);

    await expectCheckViolation(
      "UPDATE daily_inventory SET held_inventory = total_inventory + 1 WHERE business_date = $1::date",
      ["2026-08-01"],
      "daily_inventory_capacity_check",
    );
    await expectCheckViolation(
      "UPDATE daily_price SET sale_price_cents = -1 WHERE business_date = $1::date",
      ["2026-08-01"],
      "daily_price_sale_check",
    );
    await expectCheckViolation(
      "UPDATE daily_price SET rack_price_cents = sale_price_cents - 1 WHERE business_date = $1::date",
      ["2026-08-01"],
      "daily_price_rack_check",
    );
  }, 25_000);

  test("quote booking hold and history checks reject invalid persisted states", async () => {
    await applyTargetMigration();
    const fixture = await database().query<{
      property_id: string;
      room_type_id: string;
      user_id: string;
    }>(`
      SELECT u.id::text AS user_id, p.id::text AS property_id, r.id::text AS room_type_id
      FROM "user" u CROSS JOIN property p CROSS JOIN room_type r
      LIMIT 1
    `);
    const ids = fixture.rows[0];
    if (ids === undefined) {
      throw new Error("Quote booking baseline fixture is missing");
    }
    const quote = await database().query<{ id: string }>(
      `
      INSERT INTO quote (
        user_id, property_id, room_type_id, checkin_date, checkout_date, guests,
        nightly_prices, property_snapshot, room_type_snapshot, booking_policy_snapshot,
        total_price_cents, fingerprint, expires_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, DATE '2026-08-01', DATE '2026-08-02', 2,
        '[15000]'::jsonb, '{"name":"fixture"}'::jsonb, '{"name":"fixture"}'::jsonb,
        'fixture policy', 15000, $4, CURRENT_TIMESTAMP + INTERVAL '5 minutes'
      ) RETURNING id::text
    `,
      [ids.user_id, ids.property_id, ids.room_type_id, "a".repeat(64)],
    );
    const quoteId = quote.rows[0]?.id;
    const booking = await database().query<{ id: string }>(
      `
      INSERT INTO booking (
        user_id, quote_id, property_id, room_type_id, booking_number, checkin_date,
        checkout_date, guests, property_snapshot, room_type_snapshot, nightly_prices,
        booking_policy_snapshot, total_price_cents, idempotency_key, expires_at, updated_at
      ) VALUES (
        $1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SF20260801ABCDEF123456', DATE '2026-08-01',
        DATE '2026-08-02', 2, '{"name":"fixture"}'::jsonb, '{"name":"fixture"}'::jsonb,
        '[15000]'::jsonb, 'fixture policy', 15000, $5, CURRENT_TIMESTAMP + INTERVAL '15 minutes', CURRENT_TIMESTAMP
      ) RETURNING id::text
    `,
      [ids.user_id, quoteId, ids.property_id, ids.room_type_id, "key_".padEnd(32, "x")],
    );
    const bookingId = booking.rows[0]?.id;
    const hold = await database().query<{ id: string }>(
      `
      INSERT INTO inventory_hold (booking_id, room_type_id, business_date, expires_at, updated_at)
      VALUES ($1::uuid, $2::uuid, DATE '2026-08-01', CURRENT_TIMESTAMP + INTERVAL '15 minutes', CURRENT_TIMESTAMP)
      RETURNING id::text
    `,
      [bookingId, ids.room_type_id],
    );
    const history = await database().query<{ id: string }>(
      `
      INSERT INTO booking_status_history (booking_id, to_status, reason, actor_type, actor_user_id)
      VALUES ($1::uuid, 'PENDING_PAYMENT', 'BOOKING_CREATED', 'USER', $2::uuid)
      RETURNING id::text
    `,
      [bookingId, ids.user_id],
    );

    await expectCheckViolation(
      "UPDATE quote SET checkout_date = checkin_date WHERE id = $1::uuid",
      [quoteId],
    );
    await expectCheckViolation("UPDATE quote SET guests = 0 WHERE id = $1::uuid", [quoteId]);
    await expectCheckViolation("UPDATE quote SET total_price_cents = -1 WHERE id = $1::uuid", [
      quoteId,
    ]);
    await expectCheckViolation("UPDATE quote SET currency = 'USD' WHERE id = $1::uuid", [quoteId]);
    await expectCheckViolation("UPDATE quote SET fingerprint = $2 WHERE id = $1::uuid", [
      quoteId,
      "A".repeat(64),
    ]);
    await expectCheckViolation("UPDATE quote SET expires_at = created_at WHERE id = $1::uuid", [
      quoteId,
    ]);
    await expectCheckViolation(
      "UPDATE booking SET checkout_date = checkin_date WHERE id = $1::uuid",
      [bookingId],
    );
    await expectCheckViolation("UPDATE booking SET guests = 11 WHERE id = $1::uuid", [bookingId]);
    await expectCheckViolation("UPDATE booking SET booking_number = 'bad' WHERE id = $1::uuid", [
      bookingId,
    ]);
    await expectCheckViolation("UPDATE booking SET idempotency_key = 'short' WHERE id = $1::uuid", [
      bookingId,
    ]);
    await expectCheckViolation("UPDATE booking SET expires_at = created_at WHERE id = $1::uuid", [
      bookingId,
    ]);
    await expectCheckViolation(
      "UPDATE inventory_hold SET expires_at = created_at WHERE id = $1::uuid",
      [hold.rows[0]?.id],
    );
    await expectCheckViolation(
      "UPDATE booking_status_history SET actor_user_id = NULL WHERE id = $1::uuid",
      [history.rows[0]?.id],
    );
    await expectCheckViolation(
      "UPDATE booking_status_history SET actor_type = 'SYSTEM' WHERE id = $1::uuid",
      [history.rows[0]?.id],
    );
  }, 25_000);
});
