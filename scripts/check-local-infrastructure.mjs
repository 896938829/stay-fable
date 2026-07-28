import { execFileSync } from "node:child_process";
import { assertHealthyServices, parseComposePs } from "./local-infrastructure-status.mjs";

const composeFile = "infrastructure/compose.yaml";
const composeArgs = ["compose", "-f", composeFile];

function runDocker(args) {
  return execFileSync("docker", [...composeArgs, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

runDocker(["config", "--quiet"]);

const containers = parseComposePs(runDocker(["ps", "--format", "json"]));
assertHealthyServices(containers);

console.log("Local PostgreSQL/PostGIS and Redis are healthy.");
