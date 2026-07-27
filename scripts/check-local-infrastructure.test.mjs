import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assertHealthyServices, parseComposePs } from "./local-infrastructure-status.mjs";

const rootUrl = new URL("../", import.meta.url);

test("pins the local PostgreSQL/PostGIS and Redis service contract", async () => {
  const compose = await readFile(new URL("infrastructure/compose.yaml", rootUrl), "utf8");

  assert.match(compose, /^\s+image:\s+postgis\/postgis:17-3\.5$/m);
  assert.match(compose, /^\s+image:\s+redis:7\.4-alpine$/m);
  assert.match(
    compose,
    /^\s+test:\s+\["CMD-SHELL",\s*"pg_isready -U stay_fable -d stay_fable"\]$/m,
  );
  assert.match(compose, /^\s+test:\s+\["CMD",\s*"redis-cli",\s*"ping"\]$/m);
});

test("documents a bounded first-start health wait", async () => {
  const guide = await readFile(new URL("docs/operations/local-development.md", rootUrl), "utf8");

  assert.match(
    guide,
    /docker compose -f infrastructure\/compose\.yaml up -d --wait --wait-timeout 120/,
  );
});

test("parses Docker Compose JSON array output", () => {
  const services = parseComposePs(
    JSON.stringify([
      { Service: "postgres", Health: "healthy" },
      { Service: "redis", Health: "healthy" },
    ]),
  );

  assert.equal(services.length, 2);
  assert.equal(services[0].Service, "postgres");
  assert.equal(services[1].Service, "redis");
});

test("parses Docker Compose NDJSON output with Windows line endings", () => {
  const services = parseComposePs(
    '{"Service":"postgres","Health":"healthy"}\r\n' + '{"Service":"redis","Health":"healthy"}\r\n',
  );

  assert.equal(services.length, 2);
  assert.equal(services[0].Service, "postgres");
  assert.equal(services[1].Service, "redis");
});

test("reports a missing required service", () => {
  assert.throws(
    () => assertHealthyServices([{ Service: "postgres", Health: "healthy" }]),
    /redis.*missing/i,
  );
});

test("reports a service that is still starting", () => {
  assert.throws(
    () =>
      assertHealthyServices([
        { Service: "postgres", Health: "starting" },
        { Service: "redis", Health: "healthy" },
      ]),
    /postgres.*starting/i,
  );
});

test("reports an unhealthy service", () => {
  assert.throws(
    () =>
      assertHealthyServices([
        { Service: "postgres", Health: "healthy" },
        { Service: "redis", Health: "unhealthy" },
      ]),
    /redis.*unhealthy/i,
  );
});
