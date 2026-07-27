Status: Draft for pre-production verification
Owner role: Platform Owner
Review cadence: Before each environment launch and quarterly after launch

# Cloud provisioning checklist

This checklist is an execution record, not proof that a control exists. The Platform Owner links
provider exports or screenshots from the access-controlled evidence store before changing a status.
Production approval requires every required control to be verified and any exception to be signed by
the Security Owner.

| Control                    | Required state                                                                                                                                                                        | Evidence                                                         | Status      |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ----------- |
| Network separation         | Staging and production use separate VPCs, subnets, security groups, accounts or projects, credentials, and data stores; routes do not join the environments                           | Controlled evidence store: `phase-0/cloud/network-separation/`   | Not started |
| PostgreSQL 17              | PostgreSQL 17 is highly available with PostGIS, SSL required in transit, provider TDE at rest, automated backups and transaction-log backups, capacity alerts, and no public endpoint | Controlled evidence store: `phase-0/cloud/postgresql/`           | Not started |
| Redis                      | Highly available Redis requires authentication, is reachable only on private networks, and has memory, eviction, connection, and availability alerts                                  | Controlled evidence store: `phase-0/cloud/redis/`                | Not started |
| CloudBase Run API          | API runs from an immutable image with at least one instance, private data-store access, HTTPS ingress, and configured live and readiness probes                                       | Controlled evidence store: `phase-0/cloud/cloudbase-run/api/`    | Not started |
| CloudBase Run worker       | Worker runs from an immutable image with at least one instance, private data-store access, no public ingress, and graceful shutdown settings                                          | Controlled evidence store: `phase-0/cloud/cloudbase-run/worker/` | Not started |
| EdgeOne and WAF            | EdgeOne and WAF restrict origin access, enforce modern TLS, apply route-aware rate limits, and alert on blocked attacks and anomalous traffic                                         | Controlled evidence store: `phase-0/cloud/edgeone-waf/`          | Not started |
| COS quarantine bucket      | Untrusted uploads are isolated in a private `quarantine` bucket and cannot be served before malware and content checks pass                                                           | Controlled evidence store: `phase-0/cloud/cos/quarantine/`       | Not started |
| COS public bucket          | Approved public media is isolated in a read-only delivery bucket; write access is limited to the promotion service                                                                    | Controlled evidence store: `phase-0/cloud/cos/public/`           | Not started |
| COS secure-document bucket | Identity and merchant documents are isolated in a private `secure-document` bucket with short-lived authorized access and access logging                                              | Controlled evidence store: `phase-0/cloud/cos/secure-document/`  | Not started |
| KMS and secrets            | Secrets and encryption keys are environment-specific, stored in KMS or the managed secret service, rotated on a defined schedule, and protected against accidental deletion           | Controlled evidence store: `phase-0/cloud/kms-secrets/`          | Not started |
| CLS logging                | Application, security, WAF, database-audit, and CAM logs use separate CLS topics with field redaction, access controls, retention rules, and export protection                        | Controlled evidence store: `phase-0/cloud/cls/`                  | Not started |
| CAM access                 | People use named subaccounts or roles with least privilege and MFA; service identities are separate; quarterly access reviews remove stale access                                     | Controlled evidence store: `phase-0/cloud/cam/`                  | Not started |
| Evidence custody           | Configuration exports and screenshots are stored outside the repository in a versioned, access-controlled evidence store with reviewer and capture date                               | Controlled evidence store: `phase-0/cloud/evidence-custody/`     | Not started |

## Approval record

The Platform Owner records the immutable deployment identifier and signs the environment record only
after the Engineering Owner and Security Owner have reviewed the linked evidence. An approval cannot be inferred from
this document's presence in the repository.
