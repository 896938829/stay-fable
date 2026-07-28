import { Writable } from "node:stream";

import pino from "pino";
import { describe, expect, it } from "vitest";

import { LOGGER_REDACTION } from "../src/logger-redaction.js";

describe("LOGGER_REDACTION", () => {
  it("redacts identity secrets when a structured object contains a request body", () => {
    const code = "mock:secret-login-code";
    const refreshToken = "secret-refresh-token".padEnd(43, "x");
    const longitude = "119.987654321-secret-longitude";
    const latitude = "29.123456789-secret-latitude";
    let output = "";
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output += chunk.toString("utf8");
        callback();
      },
    });
    const logger = pino({ redact: LOGGER_REDACTION }, destination);

    logger.info({
      req: {
        body: {
          code,
          refresh_token: refreshToken,
          longitude,
          latitude,
        },
      },
    });

    expect(output).toContain("[REDACTED]");
    expect(output).not.toContain(code);
    expect(output).not.toContain(refreshToken);
    expect(output).not.toContain(longitude);
    expect(output).not.toContain(latitude);
  });
});
