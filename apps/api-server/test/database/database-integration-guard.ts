export const unsafeDatabaseIntegrationUrlError =
  "Unsafe database integration URL: expected a loopback host and a database name ending in _test or _ci";

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export const requireSafeDatabaseIntegrationUrl = (databaseUrl: string | undefined): string => {
  try {
    if (databaseUrl === undefined) {
      throw new Error(unsafeDatabaseIntegrationUrlError);
    }

    const parsed = new URL(databaseUrl);
    const databaseName = decodeURIComponent(parsed.pathname.slice(1));
    const safeDatabaseName = databaseName.endsWith("_test") || databaseName.endsWith("_ci");

    if (
      parsed.protocol !== "postgresql:" ||
      !loopbackHosts.has(parsed.hostname) ||
      !safeDatabaseName ||
      databaseName.includes("/")
    ) {
      throw new Error(unsafeDatabaseIntegrationUrlError);
    }

    return databaseUrl;
  } catch {
    throw new Error(unsafeDatabaseIntegrationUrlError);
  }
};
