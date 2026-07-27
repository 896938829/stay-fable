Status: Draft for pre-production verification
Owner role: Platform Owner
Review cadence: Quarterly and after staffing, responsibility, or production-access changes

# Operating ownership

People may hold more than one role in a small team, but approvals, logs, reviews, and evidence always
identify the role exercised. One to three people may cover the roles initially; role boundaries remain
auditable and a person must not independently approve their own high-risk change.

| Role                  | Accountabilities                                                                                                                                                   |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Platform Owner        | Defines scope and budget, owns environment boundaries and cloud provisioning, accepts operational risk, and gives final production approval after all gates pass   |
| Security Owner        | Owns least privilege, quarterly access review, threat and vulnerability response, incident command policy, security exceptions, and evidence protection            |
| Data Protection Owner | Owns the data inventory, notices and processor review, user data requests, retention and deletion, privacy incident assessment, and qualified counsel coordination |
| Engineering Owner     | Owns architecture, implementation, CI, database migration review, observability, backup drill execution, service reliability, and technical remediation            |
| Operations Owner      | Owns merchant onboarding, property and content quality, order fulfilment, customer support, escalation, and operational reconciliation inputs                      |
| Finance Owner         | Owns payment and refund controls, settlement, reconciliation, finance-provider access, discrepancies, and financial evidence                                       |

## Separation and delegation

- Production changes require an Engineering implementer and a different reviewer; the Platform Owner
  gives launch approval only after Security and Data Protection gates are recorded.
- Security exceptions require the Security Owner and release approver. A person who requests an
  exception cannot be its sole approver.
- Finance access is distinct from merchant operations access. Payment certificate custody and
  reconciliation approval are logged by role.
- Delegation records name the acting person, role, scope, start, expiry, and approver in the controlled
  access register.
