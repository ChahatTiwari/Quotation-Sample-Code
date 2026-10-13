# Optimized Versioned Quotation API

A portfolio example of a concurrency-safe TypeScript service using PostgreSQL.

## Engineering choices

- Atomic compare-and-swap update using `WHERE id = $id AND revision = $expectedRevision`.
- One transaction for current state and revision history.
- Zod validation at the trust boundary, including UUID validation.
- Parameterized SQL.
- 404 vs 409 distinction only on the unsuccessful-update path, so successful updates avoid an extra query.
- `finally` always releases the pooled connection.
- Integration test examples cover concurrent writers, history consistency, missing records, and rollback.

## Run tests

Use a disposable PostgreSQL database, apply `sql/schema.sql`, and set `TEST_DATABASE_URL`. Install dependencies and configure TypeScript/Jest as needed.

The integration tests require PostgreSQL; they are not substitutes for running the suite in CI.

## Production work still required

This is a portfolio reference, not a turnkey production service. Add authenticated identity and authorization, route/controller error mapping, structured logs and metrics, migrations, request rate/size limits, database statement/lock timeouts, and a creation service that inserts quotation revision 1 atomically. Consider whether `amountCents` should be accepted as a decimal string at the API boundary to avoid JSON-number precision concerns across clients.
