export function parseComposePs(output) {
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

export function assertHealthyServices(services, required = ["postgres", "redis"]) {
  for (const serviceName of required) {
    const service = services.find(
      (candidate) => candidate.Service === serviceName || candidate.service === serviceName,
    );
    const status = service?.Health ?? service?.health ?? "missing";

    if (status !== "healthy") {
      throw new Error(`Local ${serviceName} service status: ${status}.`);
    }
  }
}
