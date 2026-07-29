import assert from "node:assert/strict";
import test from "node:test";

import { verifySliceOneRuntime } from "./verify-slice-1-runtime.mjs";

function response(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
  };
}

test("verifies identity isolation, refresh rotation, cities, and location without logging secrets", async () => {
  const userA = "11111111-1111-4111-8111-111111111111";
  const userB = "22222222-2222-4222-8222-222222222222";
  const sessionA = {
    access_token: "a".repeat(32),
    refresh_token: "r".repeat(32),
    user: { id: userA },
  };
  const rotated = {
    access_token: "b".repeat(32),
    refresh_token: "s".repeat(32),
    user: { id: userA },
  };
  const responses = [
    response(201, { data: sessionA }),
    response(201, { data: { ...sessionA, access_token: "c".repeat(32) } }),
    response(201, {
      data: {
        access_token: "d".repeat(32),
        refresh_token: "t".repeat(32),
        user: { id: userB },
      },
    }),
    response(200, {
      data: [
        { id: "10000000-0000-4000-8000-000000000001", code: "330100", name: "杭州" },
        { id: "10000000-0000-4000-8000-000000000002", code: "520100", name: "贵阳" },
      ],
    }),
    response(200, {
      data: {
        city: {
          id: "10000000-0000-4000-8000-000000000001",
          code: "330100",
          name: "杭州",
        },
        distance_meters: 0,
      },
    }),
    response(422, { error: { code: "CITY_NOT_SUPPORTED" } }),
    response(201, { data: rotated }),
    response(401, { error: { code: "AUTH_REFRESH_REJECTED" } }),
  ];
  const calls = [];
  const fetch = async (url, options = {}) => {
    calls.push({ url, options });
    return responses.shift();
  };
  const logs = [];

  await verifySliceOneRuntime({
    baseUrl: "http://api:3000",
    fetch,
    log: (message) => logs.push(message),
  });

  assert.equal(responses.length, 0);
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      "http://api:3000/api/v1/auth/wechat/login",
      "http://api:3000/api/v1/auth/wechat/login",
      "http://api:3000/api/v1/auth/wechat/login",
      "http://api:3000/api/v1/cities",
      "http://api:3000/api/v1/location/resolve",
      "http://api:3000/api/v1/location/resolve",
      "http://api:3000/api/v1/auth/session/refresh",
      "http://api:3000/api/v1/auth/session/refresh",
    ],
  );
  const renderedLogs = logs.join("\n");
  assert.match(renderedLogs, /identity isolation: pass/);
  for (const secret of [
    sessionA.access_token,
    sessionA.refresh_token,
    rotated.access_token,
    rotated.refresh_token,
  ]) {
    assert.doesNotMatch(renderedLogs, new RegExp(secret));
  }
});
