import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../generated/prisma/client.js";

const requireDatabaseUrl = (): string => {
  const databaseUrl = process.env.DATABASE_URL;

  if (databaseUrl === undefined || databaseUrl.length === 0) {
    throw new Error("DATABASE_URL is required");
  }

  return databaseUrl;
};

@Injectable()
export class DatabaseService extends PrismaClient implements OnModuleDestroy {
  constructor() {
    super({
      adapter: new PrismaPg({
        connectionString: requireDatabaseUrl(),
        connectionTimeoutMillis: 5_000,
        idleTimeoutMillis: 10_000,
        max: 10,
      }),
    });
  }

  async check(): Promise<void> {
    await this.$queryRawUnsafe("SELECT 1");
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
