export const LOGGER_REDACTION = {
  paths: [
    "req.headers.authorization",
    "req.headers.cookie",
    "req.body.code",
    "req.body.password",
    "req.body.idCardNumber",
    "req.body.refresh_token",
  ],
  censor: "[REDACTED]",
};
