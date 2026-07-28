import { parseRuntimeEnvironment } from "@stay-fable/validation";

export const validateRuntimeConfig = (environment: Record<string, unknown>) =>
  parseRuntimeEnvironment(environment);
