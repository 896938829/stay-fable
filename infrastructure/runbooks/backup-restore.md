Status: Draft for pre-production verification
Owner role: Engineering Owner and Platform Owner
Review cadence: Six-monthly and after database, backup, or network architecture changes

# PostgreSQL backup restoration runbook

Control status: Not started. No restoration drill has been performed for this project. The first
staging drill must be observed by the Engineering Owner and the Platform Owner; production data must not be
copied into a less controlled environment.

## Seven-step restoration drill

1. Record the most recent recoverable point shown by the managed backup and transaction-log service, the source instance identifier, the requested recovery time, the operator, and the evidence-store case.
2. Restore into a new isolated instance in a dedicated recovery subnet inside the same-class VPC, with no public endpoint and no application route.
3. Create a temporary read-only verification account through the approved secret workflow; restrict its source network and expiry, and do not reuse an application credential.
4. Verify PostGIS availability, migration history, expected table counts, critical constraints, and representative integrity checks without changing restored data.
5. Run the API readiness check against the isolated instance through a private test runner with no public traffic or customer requests.
6. Record measured recovery point objective (RPO) and recovery time objective (RTO), backup identifiers, timestamps, test results, exceptions, and log links in the controlled evidence store.
7. Before cleanup, the Platform Owner's sign-off must reference the restored instance's exact immutable resource ID. Confirm it is different from the source instance ID, belongs to the recovery network, and received no business traffic; a second role, the Security Owner or an Engineering Owner who was not the deletion operator, independently reviews those facts and the provider deletion plan preview. Revoke the temporary account and credentials, delete only that reviewed recovery resource, then retain the cloud audit event and proof that the resource no longer exists.

## Acceptance criteria

- Measured RPO is no more than 15 minutes.
- Measured RTO is no more than 2 hours.
- PostGIS, migration history, counts, constraints, integrity checks, and readiness all pass.
- The restoration remains isolated and private for the full drill.
- Cleanup and approval evidence is retained with the drill record.

Until an actual drill meets every criterion, the backup restoration control remains `Not started` or
`In review`; this runbook is not restoration evidence.
