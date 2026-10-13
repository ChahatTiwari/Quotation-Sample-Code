//Hi I am Chahat developer of this project. I have written this file quotation-service.ts which contains the implementation of the QuotationService class. This class provides a method to update a quotation in the database. It uses the pg library to interact with a PostgreSQL database and the zod library for input validation. The class also defines custom error classes for handling validation errors, not found errors, and conflict errors. The update method performs an atomic compare-and-swap operation to ensure that concurrent requests with the same expected revision cannot both advance the same row.

// this is a sample of working project enjoy  

import { Pool, PoolClient } from "pg";
import { z } from "zod";

const UUID = z.string().uuid();

const UpdateQuotationInput = z.object({
  expectedRevision: z.number().int().positive().max(2_147_483_646),
  customerName: z.string().trim().min(1).max(200),
  // Keep cents as a safe JS integer at the API boundary. PostgreSQL BIGINT
  // values are returned as strings by node-postgres to avoid precision loss.
  amountCents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
}).strict();

export class AppError extends Error {
  constructor(
    message: string,
    readonly statusCode: 400 | 404 | 409,
    readonly code: "VALIDATION_ERROR" | "NOT_FOUND" | "REVISION_CONFLICT",
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR");
  }
}
export class NotFoundError extends AppError {
  constructor() {
    super("Quotation not found", 404, "NOT_FOUND");
  }
}
export class ConflictError extends AppError {
  constructor() {
    super("Quotation changed; reload the latest revision before editing", 409, "REVISION_CONFLICT");
  }
}

export interface Quotation {
  id: string;
  customerName: string;
  amountCents: string;
  revision: number;
  updatedAt: Date;
}
type DbQuotation = {
  id: string;
  customer_name: string;
  amount_cents: string;
  revision: number;
  updated_at: Date;
};

function toQuotation(row: DbQuotation): Quotation {
  return {
    id: row.id,
    customerName: row.customer_name,
    amountCents: row.amount_cents,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

async function rollbackQuietly(client: PoolClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // Do not mask the original error. Configure pool/client error monitoring
    // so rollback failures and broken connections remain observable.
  }
}

export class QuotationService {
  constructor(private readonly pool: Pool) {}

  async update(id: string, untrustedInput: unknown): Promise<Quotation> {
    const parsedId = UUID.safeParse(id);
    if (!parsedId.success) {
      throw new ValidationError("Quotation ID must be a valid UUID");
    }

    const parsed = UpdateQuotationInput.safeParse(untrustedInput);
    if (!parsed.success) {
      throw new ValidationError(
        parsed.error.issues.map(issue => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; "),
      );
    }

    const input = parsed.data;
    const client = await this.pool.connect();
    let transactionStarted = false;

    try {
      await client.query("BEGIN");
      transactionStarted = true;

      // Atomic compare-and-swap: concurrent requests with the same expected
      // revision cannot both advance the same row.
      const result = await client.query<DbQuotation>(
        `UPDATE quotations
            SET customer_name = $1,
                amount_cents = $2,
                revision = revision + 1,
                updated_at = now()
          WHERE id = $3
            AND revision = $4
        RETURNING id, customer_name, amount_cents, revision, updated_at`,
        [input.customerName, input.amountCents, parsedId.data, input.expectedRevision],
      );

      if (result.rowCount !== 1) {
        // This extra query is deliberately on the conflict path only: it
        // distinguishes 404 from 409 without adding work to successful updates.
        const exists = await client.query(
          "SELECT 1 FROM quotations WHERE id = $1",
          [parsedId.data],
        );
        if (exists.rowCount === 0) throw new NotFoundError();
        throw new ConflictError();
      }

      const updated = result.rows[0];

      // The history row and current state must commit or roll back together.
      await client.query(
        `INSERT INTO quotation_revisions
           (quotation_id, revision, customer_name, amount_cents)
         VALUES ($1, $2, $3, $4)`,
        [updated.id, updated.revision, updated.customer_name, updated.amount_cents],
      );

      await client.query("COMMIT");
      transactionStarted = false;
      return toQuotation(updated);
    } catch (error) {
      if (transactionStarted) await rollbackQuietly(client);
      throw error;
    } finally {
      client.release();
    }
  }
}
