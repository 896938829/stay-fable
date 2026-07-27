Status: Draft for pre-production verification
Owner role: Data Protection Owner
Review cadence: Annual, after legal review, and before changing a data category or deletion job

# Data retention and deletion policy

These defaults express product minimization targets. Qualified mainland China legal counsel must
confirm statutory, contractual, consumer, lodging, payment, tax, and dispute periods before
production. The Data Protection Owner records any approved change and Engineering verifies deletion.

| Data                               | Default period                                                                                 | End-of-period action                                                                                                       | Exception approval                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Behavior analytics events          | 13 months from event                                                                           | Delete event-level records or convert to irreversible aggregates that cannot identify a person or device                   | Data Protection Owner for a documented measurement need; Security Owner also approves security-related use |
| Application logs                   | 180 days from event                                                                            | Automatically expire from CLS and protected exports                                                                        | Security Owner may approve an incident evidence hold with case, scope, custodian, and review date          |
| Security audit logs                | 3 years from event                                                                             | Automatically expire after confirmation that no approved investigation or legal hold applies                               | Security Owner and Data Protection Owner                                                                   |
| Abandoned quote and inventory hold | 90 days after expiry or abandonment                                                            | Delete customer link and request context; retain only irreversible aggregate demand metrics                                | Operations Owner and Data Protection Owner                                                                 |
| Account data                       | Active account period plus the shortest confirmed statutory or contractual period              | Delete account profile, revoke sessions, and de-identify records that must remain                                          | Data Protection Owner after qualified mainland China legal counsel confirms the applicable minimum         |
| Transaction and lodging record     | Period confirmed by qualified mainland China legal counsel before production                   | Delete or de-identify when the confirmed period, disputes, refunds, and approved holds end                                 | Data Protection Owner and Finance Owner based on recorded counsel confirmation                             |
| Identity document                  | Collect only when necessary; keep no longer than the earliest legally permitted deletion point | Delete original from the `secure-document` bucket and backups, or irreversibly de-identify if a minimal result must remain | Data Protection Owner and Security Owner based on recorded necessity and counsel confirmation              |
| Customer support case              | Case closure plus the approved service and dispute period                                      | Delete message and attachment content; retain de-identified category and outcome                                           | Operations Owner and Data Protection Owner                                                                 |
| Merchant verification document     | Active merchant period plus the shortest confirmed verification period                         | Delete original and retain only a necessary verification result where permitted                                            | Data Protection Owner and Operations Owner                                                                 |
| Backups                            | Managed rolling recovery window configured for each environment                                | Automatically expire backup, transaction-log, and restore copies at the end of the window                                  | Platform Owner and Security Owner for a time-bounded incident or recovery hold                             |

## Operational controls

- Production deletion uses scheduled, monitored jobs with counts, failures, and retry evidence.
- Legal or incident holds name the approving roles, scope, reason, review date, and release condition;
  they do not silently suspend deletion for unrelated records.
- Deletion propagates to search, analytics, caches, COS, processors, and backups as each retention
  window expires.
- Data Protection reviews a sample deletion trace and exception register at each cadence.
