/**
 * Integration-test outline.
 *
 * Run these against a dedicated disposable PostgreSQL database with the
 * schema applied. These tests are intentionally not mocked: concurrency and
 * transaction guarantees need a real database to be meaningful.
 */
import { Pool } from "pg";
import { QuotationService, ConflictError, NotFoundError, ValidationError } from "../src/quotation-service";

describe("QuotationService.update (PostgreSQL integration)", () => {
  let pool: Pool;
  let service: QuotationService;
  const id = "8a4a3d3e-89c5-4cc0-a85c-c2f2a1b4e410";

  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL) {
      throw new Error("Set TEST_DATABASE_URL to a disposable PostgreSQL database");
    }
    pool = new Pool({
      connectionString: process.env.TEST_DATABASE_URL,
      max: 5,
      connectionTimeoutMillis: 3_000,
      idleTimeoutMillis: 10_000,
    });
    service = new QuotationService(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE quotation_revisions, quotations CASCADE");
    await pool.query(
      `INSERT INTO quotations (id, customer_name, amount_cents, revision)
       VALUES ($1, 'Example Ltd', 10000, 1)`,
      [id],
    );
    await pool.query(
      `INSERT INTO quotation_revisions
         (quotation_id, revision, customer_name, amount_cents)
       VALUES ($1, 1, 'Example Ltd', 10000)`,
      [id],
    );
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("rejects invalid UUIDs before connecting", async () => {
    await expect(service.update("not-a-uuid", {
      expectedRevision: 1, customerName: "Example", amountCents: 100,
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("returns the incremented revision and writes history", async () => {
    const result = await service.update(id, {
      expectedRevision: 1, customerName: "Acme", amountCents: 12500,
    });
    expect(result.revision).toBe(2);
    const history = await pool.query(
      "SELECT revision FROM quotation_revisions WHERE quotation_id = $1 ORDER BY revision",
      [id],
    );
    expect(history.rows.map(row => row.revision)).toEqual([1, 2]);
  });

  it("allows only one concurrent writer using the same revision", async () => {
    const payload = (customerName: string) => ({
      expectedRevision: 1, customerName, amountCents: 20000,
    });
    const outcomes = await Promise.allSettled([
      service.update(id, payload("Writer A")),
      service.update(id, payload("Writer B")),
    ]);
    expect(outcomes.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find(result => result.status === "rejected");
    expect(rejected?.status).toBe("rejected");
    if (rejected?.status === "rejected") {
      expect(rejected.reason).toBeInstanceOf(ConflictError);
    }

    const history = await pool.query(
      "SELECT revision FROM quotation_revisions WHERE quotation_id = $1 ORDER BY revision",
      [id],
    );
    expect(history.rows.map(row => row.revision)).toEqual([1, 2]);
  });

  it("returns not found for a valid but nonexistent UUID", async () => {
    await expect(service.update("a2e4a1a8-1a45-4b0a-aea1-63b07e4a8129", {
      expectedRevision: 1, customerName: "Acme", amountCents: 100,
    })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rolls back the quotation update if history insertion fails", async () => {
    // Force the history insert to fail by inserting the next revision first.
    await pool.query(
      `INSERT INTO quotation_revisions
         (quotation_id, revision, customer_name, amount_cents)
       VALUES ($1, 2, 'Pre-existing row', 10000)`,
      [id],
    );

    await expect(service.update(id, {
      expectedRevision: 1, customerName: "Must roll back", amountCents: 500,
    })).rejects.toBeTruthy();

    const current = await pool.query(
      "SELECT customer_name, revision FROM quotations WHERE id = $1",
      [id],
    );
    expect(current.rows[0]).toMatchObject({ customer_name: "Example Ltd", revision: 1 });
  });
});
