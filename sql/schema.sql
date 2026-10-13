CREATE TABLE quotations (
  id UUID PRIMARY KEY,
  customer_name TEXT NOT NULL
    CHECK (length(trim(customer_name)) BETWEEN 1 AND 200),
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE quotation_revisions (
  quotation_id UUID NOT NULL REFERENCES quotations(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  customer_name TEXT NOT NULL
    CHECK (length(trim(customer_name)) BETWEEN 1 AND 200),
  amount_cents BIGINT NOT NULL CHECK (amount_cents >= 0),
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (quotation_id, revision)
);

CREATE INDEX quotation_revisions_changed_at_idx
  ON quotation_revisions (changed_at DESC);

-- Important invariant: the application’s quotation-creation workflow should
-- insert the quotation and revision 1 in the SAME transaction. The schema
-- cannot guarantee a matching history row with a simple foreign key alone.
