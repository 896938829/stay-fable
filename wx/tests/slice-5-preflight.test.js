import path from "node:path";
import { createRequire } from "node:module";

import { describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const preflight = require("../automator/slice-5-preflight.js");

const EXPECTED_PROJECT = path.resolve(
  import.meta.dirname,
  "..",
);
const EXPECTED_COMMIT = "1".repeat(40);
const EXPECTED_WX_TREE = "2".repeat(40);
const READ_ONLY_BOUNDARY = {
  state: "READ_ONLY_PREFLIGHT",
  interactionStarted: false,
};

function createDependencies(overrides = {}) {
  return {
    readCandidate: vi.fn(async () => ({
      commit: EXPECTED_COMMIT,
      wxTree: EXPECTED_WX_TREE,
      clean: true,
    })),
    readWechatIde: vi.fn(async () => ({
      versionRelation: "equal",
      loginValid: true,
      tokenRequired: false,
      tokenAvailable: false,
      projectPath: EXPECTED_PROJECT,
    })),
    readTestAccountCount: vi.fn(async () => 1),
    readApiHealth: vi.fn(async () => ({
      transport: "HTTP_LOOPBACK",
      host: "127.0.0.1",
      liveEndpoint: "/health/live",
      readyEndpoint: "/health/ready",
      live: true,
      ready: true,
    })),
    readClockDate: vi.fn(async () => "2026-07-30"),
    readSeedWindow: vi.fn(async () => ({
      available: true,
      start: "2026-07-31",
      end: "2026-08-02",
    })),
    readBaseline: vi.fn(async () => ({
      consoleErrors: 0,
      networkFailures: 0,
    })),
    ...overrides,
  };
}

function createOptions(overrides = {}) {
  return {
    expectedProjectPath: EXPECTED_PROJECT,
    expectedCommit: EXPECTED_COMMIT,
    expectedWxTree: EXPECTED_WX_TREE,
    executionDate: "2026-07-30",
    timeoutMs: 100,
    ...overrides,
  };
}

describe("Slice 5 physical UAT preflight", () => {
  it("returns a bounded safe READY summary only after every read-only check passes", async () => {
    const dependencies = createDependencies();

    const result = await preflight.runPreflight(
      createOptions(),
      dependencies,
    );

    expect(result).toEqual({
      schemaVersion: 1,
      status: "READY",
      reason: "PREFLIGHT_READY",
      candidate: {
        commit: EXPECTED_COMMIT,
        wxTree: EXPECTED_WX_TREE,
      },
      seedWindow: {
        start: "2026-07-31",
        end: "2026-08-02",
      },
      checks: {
        candidate: "PASS",
        wechatide: "PASS",
        testAccount: "PASS",
        api: "PASS",
        dataWindow: "PASS",
        baseline: "PASS",
      },
      executionBoundary: READ_ONLY_BOUNDARY,
    });
    for (const reader of [
      dependencies.readCandidate,
      dependencies.readWechatIde,
      dependencies.readTestAccountCount,
      dependencies.readApiHealth,
      dependencies.readClockDate,
      dependencies.readSeedWindow,
      dependencies.readBaseline,
    ]) {
      expect(reader).toHaveBeenCalledOnce();
    }
  });

  it.each([
    {
      name: "candidate mismatch",
      overrides: {
        readCandidate: vi.fn(async () => ({
          commit: "3".repeat(40),
          wxTree: EXPECTED_WX_TREE,
          clean: true,
        })),
      },
      status: "BLOCKED_AUTOMATOR_RC",
      reason: "CANDIDATE_MISMATCH",
    },
    {
      name: "dirty candidate tree",
      overrides: {
        readCandidate: vi.fn(async () => ({
          commit: EXPECTED_COMMIT,
          wxTree: EXPECTED_WX_TREE,
          clean: false,
        })),
      },
      status: "BLOCKED_AUTOMATOR_RC",
      reason: "CANDIDATE_MISMATCH",
    },
    {
      name: "wrong worktree window",
      overrides: {
        readWechatIde: vi.fn(async () => ({
          versionRelation: "equal",
          loginValid: true,
          tokenRequired: false,
          tokenAvailable: false,
          projectPath: path.resolve(EXPECTED_PROJECT, "..", "other"),
        })),
      },
      status: "BLOCKED_AUTOMATOR_RC",
      reason: "WECHATIDE_CONTEXT_INVALID",
    },
    {
      name: "missing test account",
      overrides: {
        readTestAccountCount: vi.fn(async () => 0),
      },
      status: "BLOCKED_TEST_ACCOUNT",
      reason: "TEST_ACCOUNT_UNAVAILABLE",
    },
    {
      name: "API not ready",
      overrides: {
        readApiHealth: vi.fn(async () => ({
          transport: "HTTP_LOOPBACK",
          host: "127.0.0.1",
          liveEndpoint: "/health/live",
          readyEndpoint: "/health/ready",
          live: true,
          ready: false,
        })),
      },
      status: "BLOCKED_API",
      reason: "API_NOT_READY",
    },
    {
      name: "seed window unavailable",
      overrides: {
        readSeedWindow: vi.fn(async () => ({ available: false })),
      },
      status: "BLOCKED_DATA_WINDOW",
      reason: "SEED_WINDOW_UNAVAILABLE",
    },
    {
      name: "dirty runtime baseline",
      overrides: {
        readBaseline: vi.fn(async () => ({
          consoleErrors: 1,
          networkFailures: 0,
        })),
      },
      status: "FAILED_PRODUCT",
      reason: "RUNTIME_BASELINE_FAILED",
    },
  ])(
    "stops safely before tap/write for $name",
    async ({ overrides, status, reason }) => {
      const dependencies = createDependencies(overrides);

      const result = await preflight.runPreflight(
        createOptions(),
        dependencies,
      );

      expect(result.status).toBe(status);
      expect(result.reason).toBe(reason);
      expect(result.executionBoundary).toEqual(READ_ONLY_BOUNDARY);
      expect(JSON.stringify(result)).not.toContain("other");
    },
  );

  it.each([
    {
      versionRelation: "agent_ahead",
      loginValid: true,
      tokenRequired: false,
      tokenAvailable: false,
    },
    {
      versionRelation: "agent_behind",
      loginValid: true,
      tokenRequired: false,
      tokenAvailable: false,
    },
    {
      versionRelation: "equal",
      loginValid: false,
      tokenRequired: false,
      tokenAvailable: false,
    },
    {
      versionRelation: "equal",
      loginValid: true,
      tokenRequired: true,
      tokenAvailable: false,
    },
  ])("blocks an unusable WechatIDE session without leaking its details", async (ide) => {
    const secret = "never-print-this-token";
    const dependencies = createDependencies({
      readWechatIde: vi.fn(async () => ({
        ...ide,
        projectPath: EXPECTED_PROJECT,
        diagnostic: secret,
      })),
    });

    const result = await preflight.runPreflight(
      createOptions(),
      dependencies,
    );

    expect(result).toMatchObject({
      status: "BLOCKED_AUTOMATOR_RC",
      reason: "WECHATIDE_CONTEXT_INVALID",
      executionBoundary: READ_ONLY_BOUNDARY,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("turns dependency errors and timeouts into constant non-leaking blockers", async () => {
    vi.useFakeTimers();
    try {
      const secret = "https://example.invalid?access_token=secret";
      const rejected = createDependencies({
        readCandidate: vi.fn(async () => {
          throw new Error(secret);
        }),
      });
      const rejectionResult = await preflight.runPreflight(
        createOptions(),
        rejected,
      );
      expect(rejectionResult).toMatchObject({
        status: "BLOCKED_AUTOMATOR_RC",
        reason: "PREFLIGHT_READ_FAILED",
      });
      expect(JSON.stringify(rejectionResult)).not.toContain(secret);

      const timedOut = createDependencies({
        readCandidate: vi.fn(() => new Promise(() => {})),
      });
      const pending = preflight.runPreflight(
        createOptions({ timeoutMs: 20 }),
        timedOut,
      );
      await vi.advanceTimersByTimeAsync(21);
      await expect(pending).resolves.toMatchObject({
        status: "BLOCKED_AUTOMATOR_RC",
        reason: "PREFLIGHT_READ_FAILED",
        executionBoundary: READ_ONLY_BOUNDARY,
      });
      expect(timedOut.readWechatIde).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects malformed, inherited, getter and Proxy input as safe blockers", async () => {
    const getter = {};
    Object.defineProperty(getter, "commit", {
      enumerable: true,
      get() {
        throw new Error("getter secret");
      },
    });
    getter.wxTree = EXPECTED_WX_TREE;

    const trap = vi.fn(() => {
      throw new Error("proxy secret");
    });
    const proxy = new Proxy({}, { ownKeys: trap });

    for (const candidate of [
      getter,
      proxy,
      Object.assign(Object.create({ inherited: true }), {
        commit: EXPECTED_COMMIT,
        wxTree: EXPECTED_WX_TREE,
        clean: true,
      }),
    ]) {
      const dependencies = createDependencies({
        readCandidate: vi.fn(async () => candidate),
      });
      const result = await preflight.runPreflight(
        createOptions(),
        dependencies,
      );

      expect(result).toMatchObject({
        status: "BLOCKED_AUTOMATOR_RC",
        reason: "PREFLIGHT_READ_FAILED",
        executionBoundary: READ_ONLY_BOUNDARY,
      });
      expect(JSON.stringify(result)).not.toMatch(/secret|inherited/);
    }
    expect(trap).not.toHaveBeenCalled();
  });

  it("rejects invalid options before invoking any dependency", async () => {
    const dependencies = createDependencies();

    const result = await preflight.runPreflight(
      createOptions({ expectedCommit: "not-a-commit" }),
      dependencies,
    );

    expect(result).toMatchObject({
      status: "BLOCKED_AUTOMATOR_RC",
      reason: "PREFLIGHT_CONFIGURATION_INVALID",
      executionBoundary: READ_ONLY_BOUNDARY,
    });
    for (const value of Object.values(dependencies)) {
      expect(value).not.toHaveBeenCalled();
    }
  });

  it.each([
    {
      reader: "readApiHealth",
      status: "BLOCKED_API",
      reason: "API_NOT_READY",
    },
    {
      reader: "readSeedWindow",
      status: "BLOCKED_DATA_WINDOW",
      reason: "SEED_WINDOW_UNAVAILABLE",
    },
  ])(
    "classifies a rejected $reader read without leaking its error",
    async ({ reader, status, reason }) => {
      const secret = "https://example.invalid?secret=do-not-print";
      const dependencies = createDependencies({
        [reader]: vi.fn(async () => {
          throw new Error(secret);
        }),
      });

      const result = await preflight.runPreflight(
        createOptions(),
        dependencies,
      );

      expect(result).toMatchObject({
        status,
        reason,
        executionBoundary: READ_ONLY_BOUNDARY,
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    },
  );

  it.each([
    ["external host", { host: "api.example.invalid" }],
    ["hostname instead of numeric loopback", { host: "localhost" }],
    ["wrong transport", { transport: "HTTPS_REMOTE" }],
    ["wrong live endpoint", { liveEndpoint: "/live" }],
    ["wrong ready endpoint", { readyEndpoint: "/ready" }],
    ["live endpoint unhealthy", { live: false }],
    ["unknown URL field", { url: "http://127.0.0.1/health/ready" }],
  ])("blocks an API snapshot with %s", async (_label, drift) => {
    const dependencies = createDependencies({
      readApiHealth: vi.fn(async () => ({
        transport: "HTTP_LOOPBACK",
        host: "127.0.0.1",
        liveEndpoint: "/health/live",
        readyEndpoint: "/health/ready",
        live: true,
        ready: true,
        ...drift,
      })),
    });

    const result = await preflight.runPreflight(
      createOptions(),
      dependencies,
    );

    expect(result).toMatchObject({
      status: "BLOCKED_API",
      reason: "API_NOT_READY",
      executionBoundary: READ_ONLY_BOUNDARY,
    });
    expect(JSON.stringify(result)).not.toMatch(/example|127\.0\.0\.1|health/);
    expect(dependencies.readClockDate).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "clock drift",
      overrides: {
        readClockDate: vi.fn(async () => "2026-07-31"),
      },
    },
    {
      name: "past seed start",
      overrides: {
        readSeedWindow: vi.fn(async () => ({
          available: true,
          start: "2026-07-30",
          end: "2026-08-01",
        })),
      },
    },
    {
      name: "short seed end",
      overrides: {
        readSeedWindow: vi.fn(async () => ({
          available: true,
          start: "2026-07-31",
          end: "2026-08-01",
        })),
      },
    },
  ])(
    "blocks $name instead of accepting a stale data window",
    async ({ overrides }) => {
      const dependencies = createDependencies(overrides);

      const result = await preflight.runPreflight(
        createOptions(),
        dependencies,
      );

      expect(result).toMatchObject({
        status: "BLOCKED_DATA_WINDOW",
        reason: "SEED_WINDOW_UNAVAILABLE",
        executionBoundary: READ_ONLY_BOUNDARY,
      });
      expect(dependencies.readBaseline).not.toHaveBeenCalled();
    },
  );

  it("derives D+1 through D+3 across a month boundary", async () => {
    const dependencies = createDependencies({
      readClockDate: vi.fn(async () => "2026-12-31"),
      readSeedWindow: vi.fn(async () => ({
        available: true,
        start: "2027-01-01",
        end: "2027-01-03",
      })),
    });

    const result = await preflight.runPreflight(
      createOptions({ executionDate: "2026-12-31" }),
      dependencies,
    );

    expect(result.status).toBe("READY");
    expect(result.seedWindow).toEqual({
      start: "2027-01-01",
      end: "2027-01-03",
    });
  });

  it("snapshots validated candidate and seed values before later readers can mutate them", async () => {
    const candidate = {
      commit: EXPECTED_COMMIT,
      wxTree: EXPECTED_WX_TREE,
      clean: true,
    };
    const seedWindow = {
      available: true,
      start: "2026-07-31",
      end: "2026-08-02",
    };
    const dependencies = createDependencies({
      readCandidate: vi.fn(async () => candidate),
      readWechatIde: vi.fn(async () => {
        candidate.commit = "secret-after-validation";
        return {
          versionRelation: "equal",
          loginValid: true,
          tokenRequired: false,
          tokenAvailable: false,
          projectPath: EXPECTED_PROJECT,
        };
      }),
      readSeedWindow: vi.fn(async () => seedWindow),
      readBaseline: vi.fn(async () => {
        seedWindow.start = "secret-after-validation";
        return { consoleErrors: 0, networkFailures: 0 };
      }),
    });

    const result = await preflight.runPreflight(
      createOptions(),
      dependencies,
    );

    expect(result.status).toBe("READY");
    expect(result.candidate).toEqual({
      commit: EXPECTED_COMMIT,
      wxTree: EXPECTED_WX_TREE,
    });
    expect(result.seedWindow).toEqual({
      start: "2026-07-31",
      end: "2026-08-02",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it.each(["tap", "write", "exec", "fs"])(
    "rejects a dependency boundary that exposes %s capability",
    async (capability) => {
      const dependencies = createDependencies({
        [capability]: vi.fn(),
      });

      const result = await preflight.runPreflight(
        createOptions(),
        dependencies,
      );

      expect(result).toMatchObject({
        status: "BLOCKED_AUTOMATOR_RC",
        reason: "PREFLIGHT_CONFIGURATION_INVALID",
        executionBoundary: READ_ONLY_BOUNDARY,
      });
      expect(result).not.toHaveProperty("interaction");
      expect(dependencies[capability]).not.toHaveBeenCalled();
    },
  );

  it("aborts a timed-out cooperative reader before its late callback can act", async () => {
    vi.useFakeTimers();
    try {
      let lateEffects = 0;
      let observedSignal;
      const dependencies = createDependencies({
        readCandidate: vi.fn(
          ({ signal } = {}) =>
            new Promise((resolve) => {
              observedSignal = signal;
              setTimeout(() => {
                if (!signal?.aborted) {
                  lateEffects += 1;
                }
                resolve({
                  commit: EXPECTED_COMMIT,
                  wxTree: EXPECTED_WX_TREE,
                  clean: true,
                });
              }, 30);
            }),
        ),
      });

      const pending = preflight.runPreflight(
        createOptions({ timeoutMs: 10 }),
        dependencies,
      );
      await vi.advanceTimersByTimeAsync(11);
      await expect(pending).resolves.toMatchObject({
        status: "BLOCKED_AUTOMATOR_RC",
        reason: "PREFLIGHT_READ_FAILED",
      });
      expect(observedSignal).toBeInstanceOf(AbortSignal);
      expect(observedSignal.aborted).toBe(true);
      await vi.advanceTimersByTimeAsync(30);
      expect(lateEffects).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not invoke dependency getters while validating the read boundary", async () => {
    const getter = vi.fn(() => {
      throw new Error("dependency getter secret");
    });
    const dependencies = createDependencies();
    Object.defineProperty(dependencies, "readCandidate", {
      enumerable: true,
      get: getter,
    });

    const result = await preflight.runPreflight(
      createOptions(),
      dependencies,
    );

    expect(result).toMatchObject({
      status: "BLOCKED_AUTOMATOR_RC",
      reason: "PREFLIGHT_CONFIGURATION_INVALID",
      executionBoundary: READ_ONLY_BOUNDARY,
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(getter).not.toHaveBeenCalled();
  });
});
