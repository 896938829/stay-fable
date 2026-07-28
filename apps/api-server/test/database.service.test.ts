import { beforeEach, describe, expect, it, vi } from "vitest";

const adapterMock = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
}));

vi.mock("@prisma/adapter-pg", () => ({
  PrismaPg: class {
    constructor(options: Record<string, unknown>) {
      adapterMock.options = options;
    }
  },
}));

vi.mock("../src/generated/prisma/client.js", () => ({
  PrismaClient: class {
    $disconnect = vi.fn(() => Promise.resolve());
    $queryRawUnsafe = vi.fn(() => Promise.resolve());
  },
}));

import { DatabaseService } from "../src/database/database.service.js";

describe("DatabaseService pool configuration", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://stay_fable:local@127.0.0.1:5432/stay_fable";
    adapterMock.options = undefined;
  });

  it("keeps a production-safe database connection timeout", () => {
    new DatabaseService();

    expect(adapterMock.options?.connectionTimeoutMillis).toBeGreaterThanOrEqual(5_000);
  });
});
