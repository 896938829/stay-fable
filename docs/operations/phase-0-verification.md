Status: Blocked
Owner role: Engineering Owner
Review cadence: At every Phase 0 verification run and weekly while any gate is blocked

# Phase 0 verification evidence

Verification date: 2026-07-27

Task 11 parent/input evidence commit: `058735e2f0f464f03bb334c015d86ece567b7e74`

Verification implementation commit: `ea77dbfe11269ad9778ee6054cadffd24fbe2b0a`

Quality-remediation input commit: `6bf55d4341ea03bfea4e8dbf8832d30ef681f55b`

The verifier and this evidence page were introduced by the verification implementation commit.
The readiness and repeatable-smoke remediation is introduced by the commit containing this page.
Its recorded commands were executed against the quality-remediation input plus the complete
remediation working state. The containing commit, rather than either earlier input, is the
reproducible source for the final verifier and smoke scripts.

This record separates deterministic repository checks from runtime and organizational checks that
need systems or accountable reviewers outside this workstation. The release status is **Blocked**:
repository quality checks do not override a failing dependency gate or missing external evidence.
The launch evidence index is the authoritative cross-reference for retained external artifacts:
[`launch-evidence-index.md`](../compliance/launch-evidence-index.md).

## Automated repository checks

| Evidence                                  | Result                           | Scope and limitation                                                                                                                                                                |
| ----------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `corepack pnpm check` and its components  | Passed locally on 2026-07-27     | Workspace contract, formatting, lint, typecheck, tests, and builds completed with exit code 0. This is repository evidence, not a hosted CI run.                                    |
| Corepack pnpm version gate                | Passed locally: exactly 11.17.0  | The verifier invokes every pnpm command through Corepack and fails before other checks if the resolved version differs.                                                             |
| Static local-infrastructure contract test | Passed locally                   | Validates Compose configuration and health-check parsing only; it does not start PostgreSQL/PostGIS or Redis.                                                                       |
| Static container contract test            | Passed locally                   | Validates pinned images, non-root `USER node`, build stages, and runtime commands as text. No image was built, inspected, scanned, or run because Docker is unavailable.            |
| Static CI contract test                   | Passed locally                   | Validates workflow structure, immutable action pins, Gitleaks invocation, and Trivy gates as repository configuration. GitHub Actions has not executed it.                          |
| Phase 0 document contract test            | Passed locally                   | Validates required controls, owner roles, evidence links, and auditable status values.                                                                                              |
| Built API runtime smoke                   | Passed locally                   | [`smoke-api-runtime.mjs`](../../scripts/smoke-api-runtime.mjs) starts built code with safe unreachable URLs, checks live 200, ready 503/down, live-after 200, and bounded shutdown. |
| Management web artifact smoke             | Passed locally                   | [`smoke-frontend-artifacts.mjs`](../../scripts/smoke-frontend-artifacts.mjs) serves the built index over ephemeral local HTTP and checks status, title, and root mount point.       |
| Mini-program artifact smoke               | Passed locally                   | The same script checks all three emitted targets and loads WeChat bundles in a VM, where exactly one App registration occurs. Official vendor GUI previews remain blocked.          |
| `pnpm verify:phase-0`                     | **Blocked as designed**          | All repository checks run in deterministic order, then the final dependency audit exits non-zero. The verifier stops and returns non-zero; it never reports Phase 0 as passed.      |
| `pnpm audit --audit-level high`           | **Blocked: 2 CRITICAL, 11 HIGH** | The current machine-readable and reviewed findings are documented in [`dependency-audit.md`](dependency-audit.md). No threshold reduction or ignored exit code is permitted.        |

The static contract tests intentionally run before the aggregate `pnpm test`: the early copies fail
fast before expensive builds, while the aggregate run proves the root test contract still includes
them.

## Runtime evidence

| Component          | Evidence observed                                                                                                                                                                                               | Status    |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| API liveness       | A real built API process returned HTTP 200 at `/health/live` without a database connection.                                                                                                                     | In review |
| API readiness      | The repeatable built-code smoke receives HTTP 503 with `status: unavailable` and both dependency checks `down`; a following `/health/live` remains HTTP 200. Live PostgreSQL/Redis readiness is still external. | Blocked   |
| API health routing | The application contract and HTTP smoke test use root `/health/live` and `/health/ready`; `/api/v1/health/live` and `/api/v1/health/ready` return 404 because health is excluded from the global API prefix.    | In review |
| Worker             | Unit tests cover configuration, startup failure handling, worker errors, and graceful shutdown. A ten-minute live run against Redis has not been performed.                                                     | Blocked   |
| Management web     | Repository smoke covers built-index HTTP 200, expected title, and root element. It does not execute the React bundle in a browser or exercise official hosting.                                                 | In review |
| Mini-program       | Repository smoke covers three emitted targets and WeChat VM App registration. WeChat, Alipay, and Douyin official GUI previews were not performed.                                                              | Blocked   |
| Containers         | Dockerfile static contracts verify `USER node`; `docker image inspect`, real builds, and non-root runtime checks were not executed.                                                                             | Blocked   |

## External runtime checks

The deterministic verifier intentionally does not fake or silently skip these gates:

| Required gate                                  | Required retained evidence                                                                                                            | Status      |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Docker Compose PostgreSQL 17/PostGIS and Redis | Bounded startup logs, `pg_isready`, PostGIS query, Redis ping, API readiness, and teardown record                                     | Blocked     |
| API and worker images                          | Successful builds, immutable image digests, `docker image inspect` user, non-root runtime identity, API probes, and worker Redis soak | Blocked     |
| GitHub Actions                                 | Hosted verify-job URL for the exact commit, including PostgreSQL/Redis service evidence                                               | Not started |
| Gitleaks and Trivy                             | Full-history secret-scan result plus API/worker image scan reports and digests                                                        | Not started |
| Official mini-program tools                    | WeChat, Alipay, and Douyin GUI preview screenshots/logs tied to the commit                                                            | Blocked     |
| Cloud resources and accounts                   | Environment-isolation checklist, least-privilege accounts, KMS/CLS/WAF evidence, domain/ICP filing, and payment-provider readiness    | Not started |
| Legal, privacy, and penetration testing        | Approved processor terms, privacy/legal sign-off, payment/legal review, and scoped penetration-test report                            | Not started |

Phase 0 cannot move to `Accepted` until the dependency audit is cleared or a permitted
time-bounded exception is jointly approved, and every applicable external gate has immutable
evidence linked from the launch evidence index.
