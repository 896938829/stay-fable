import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

const codeA = "mock:slice-1-runtime-user-a";
const codeB = "mock:slice-1-runtime-user-b";

function endpoint(baseUrl, path) {
  return `${baseUrl.replace(/\/+$/, "")}/api/v1${path}`;
}

async function requestJson(fetchImplementation, baseUrl, path, options, expectedStatus) {
  const response = await fetchImplementation(endpoint(baseUrl, path), {
    ...options,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...options?.headers,
    },
  });
  const body = await response.json();

  assert.equal(
    response.status,
    expectedStatus,
    `${options?.method || "GET"} ${path} returned HTTP ${response.status}`,
  );
  return body;
}

function bearer(accessToken) {
  return { authorization: `Bearer ${accessToken}` };
}

function login(fetchImplementation, baseUrl, code) {
  return requestJson(
    fetchImplementation,
    baseUrl,
    "/auth/wechat/login",
    { method: "POST", body: JSON.stringify({ code }) },
    201,
  );
}

export async function verifySliceOneRuntime(options = {}) {
  const baseUrl = options.baseUrl || process.env.API_BASE_URL;
  const fetchImplementation = options.fetch || globalThis.fetch;
  const log = options.log || console.log;

  assert.equal(typeof baseUrl, "string", "API_BASE_URL is required");
  assert.equal(typeof fetchImplementation, "function", "fetch is required");

  const first = (await login(fetchImplementation, baseUrl, codeA)).data;
  const repeated = (await login(fetchImplementation, baseUrl, codeA)).data;
  const different = (await login(fetchImplementation, baseUrl, codeB)).data;
  assert.equal(repeated.user.id, first.user.id, "repeated mock identity changed user");
  assert.notEqual(different.user.id, first.user.id, "different mock identities shared a user");
  log("identity isolation: pass");

  const cities = (
    await requestJson(
      fetchImplementation,
      baseUrl,
      "/cities",
      { headers: bearer(first.access_token) },
      200,
    )
  ).data;
  assert.deepEqual(
    cities.map(({ code, name }) => ({ code, name })),
    [
      { code: "330100", name: "杭州" },
      { code: "520100", name: "贵阳" },
    ],
    "seeded cities did not match the Slice 1 contract",
  );
  log("seeded cities: pass");

  const resolved = (
    await requestJson(
      fetchImplementation,
      baseUrl,
      "/location/resolve",
      {
        method: "POST",
        headers: bearer(first.access_token),
        body: JSON.stringify({ longitude: 120.1551, latitude: 30.2741 }),
      },
      200,
    )
  ).data;
  assert.equal(resolved.city.code, "330100", "Hangzhou coordinates resolved to another city");
  assert.ok(
    Number.isInteger(resolved.distance_meters) &&
      resolved.distance_meters >= 0 &&
      resolved.distance_meters < 10,
    "Hangzhou distance was outside the expected rounded range",
  );

  const far = await requestJson(
    fetchImplementation,
    baseUrl,
    "/location/resolve",
    {
      method: "POST",
      headers: bearer(first.access_token),
      body: JSON.stringify({ longitude: 0, latitude: 0 }),
    },
    422,
  );
  assert.equal(far.error?.code, "CITY_NOT_SUPPORTED", "far coordinates had the wrong error code");
  log("PostGIS location resolution: pass");

  const rotated = (
    await requestJson(
      fetchImplementation,
      baseUrl,
      "/auth/session/refresh",
      {
        method: "POST",
        body: JSON.stringify({ refresh_token: first.refresh_token }),
      },
      201,
    )
  ).data;
  assert.equal(rotated.user.id, first.user.id, "refresh changed the authenticated user");
  assert.notEqual(rotated.access_token, first.access_token, "access token was not rotated");
  assert.notEqual(rotated.refresh_token, first.refresh_token, "refresh token was not rotated");

  const replay = await requestJson(
    fetchImplementation,
    baseUrl,
    "/auth/session/refresh",
    {
      method: "POST",
      body: JSON.stringify({ refresh_token: first.refresh_token }),
    },
    401,
  );
  assert.equal(
    replay.error?.code,
    "AUTH_REFRESH_REJECTED",
    "used refresh token had the wrong replay error",
  );
  log("refresh rotation and replay rejection: pass");
}

const isCli =
  process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isCli) {
  await verifySliceOneRuntime();
}
