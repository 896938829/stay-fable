import { Pool, type PoolConfig, type PoolClient } from "pg";

export type DatabaseClient = PoolClient;

export interface DatabasePool {
  connect(): Promise<DatabaseClient>;
  end(): Promise<void>;
}

export type DatabasePoolFactory = (config: PoolConfig) => DatabasePool;

const defaultDatabasePoolFactory: DatabasePoolFactory = (config) => new Pool(config);

export const createDatabasePool = (
  databaseUrl: string,
  factory: DatabasePoolFactory = defaultDatabasePoolFactory,
): DatabasePool =>
  factory({
    connectionString: databaseUrl,
  });
