Status: Draft for pre-production verification
Owner role: Security Owner
Review cadence: Quarterly, after every material incident, and after identity or logging changes

# Security incident response runbook

Control status: Not started. This document defines role-based actions and does not claim that an
exercise, notification decision, or forensic review has occurred.

## Seven-step response

1. Assign severity, identify affected environment and assets, open a restricted incident record, appoint an Incident Commander, and activate the matching escalation path.
2. Revoke affected application sessions, CAM credentials and roles, application secrets, and payment certificates; rotate replacements through the approved secret process without putting values in the incident record.
3. Isolate affected services and preserve CLS, WAF, database audit, CAM, host, and application logs before containment changes overwrite evidence.
4. Restore a reviewed secure version from an immutable artifact, verify configuration and data integrity, and keep affected workloads isolated until Security approves controlled recovery.
5. Have the Data Protection Owner assess affected people and data, jurisdiction, contract terms, and notification obligations with qualified counsel and relevant providers.
6. Record the timeline, impact, root cause, containment and corrective actions, a single owner and due date for each action, decisions, approvals, and evidence links.
7. Monitor authentication, traffic, data integrity, application health, and security alerts for recurrence; only the Incident Commander and Security Owner may close the case after the observation period is clean.

## Contacts and escalation

| Function            | Contact mechanism                              | Escalation                                                      |
| ------------------- | ---------------------------------------------- | --------------------------------------------------------------- |
| Incident Commander  | Restricted incident channel and on-call roster | Platform Owner                                                  |
| Security Owner      | Security on-call roster                        | Executive incident sponsor                                      |
| Engineering         | Engineering on-call roster                     | Engineering Owner                                               |
| Data Protection     | Privacy incident roster                        | Qualified mainland China counsel and executive incident sponsor |
| Operations          | Operations on-call roster                      | Operations Owner                                                |
| Finance and payment | Finance incident roster                        | Finance Owner and affected payment provider                     |
| Cloud provider      | Tencent Cloud enterprise support case          | Provider security escalation                                    |

The controlled on-call system holds named people and current phone numbers. Personal contact details
must not be copied into the repository.

## Evidence preservation

- Use a restricted case identifier and record who collected each artifact, source, UTC time, hash
  where supported, transfer, and access.
- Preserve originals as read-only exports; analyze copies and retain provider audit logs for the
  export itself.
- Minimize access and disclosure, redact credentials and unrelated personal data, and suspend normal
  deletion only through an approved legal or security hold.
- Do not alter affected systems solely to make investigation easier; record every containment change
  and its author.
