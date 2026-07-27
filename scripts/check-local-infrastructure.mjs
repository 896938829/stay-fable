import { execFileSync } from "node:child_process";

const composeFile = "infrastructure/compose.yaml";
const composeArgs = ["compose", "-f", composeFile];

function runDocker(args) {
  return execFileSync("docker", [...composeArgs, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseComposePs(output) {
  const trimmed = output.trim();

  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }
}

runDocker(["config", "--quiet"]);

const containers = parseComposePs(runDocker(["ps", "--format", "json"]));
const requiredServices = ["postgres", "redis"];

for (const service of requiredServices) {
  const container = containers.find(
    (candidate) => candidate.Service === service || candidate.service === service,
  );
  const health = container?.Health ?? container?.health;

  if (health !== "healthy") {
    throw new Error(`Local ${service} service is not healthy.`);
  }
}

console.log("Local PostgreSQL/PostGIS and Redis are healthy.");
