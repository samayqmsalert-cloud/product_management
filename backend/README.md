# Product Management Backend

REST API + static frontend for the Product Management module, backed by the
`sql/001_schema_v2.sql` schema.

## Setup

```bash
npm install

# 1. Create the database and apply the schema (needs a privileged role, e.g. postgres):
createdb product_management
psql -d product_management -f ../sql/001_schema_v2.sql

# 2. Create a least-privilege app role and grant it access:
psql -d product_management <<'SQL'
CREATE ROLE erp_app LOGIN PASSWORD 'change-me';
GRANT USAGE ON SCHEMA core, product TO erp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, product TO erp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, product TO erp_app;
SQL

# 3. Load your CSVs (re-encodes, stages, then runs sql/002_migration_v1_to_v2.sql):
PRODUCTS_CSV=/path/to/products.csv VARIANTS_CSV=/path/to/variants.csv \
  PGUSER=postgres PGDATABASE=product_management \
  ./scripts/load-data.sh

# 4. Configure and run the API:
cp .env.example .env   # edit PGUSER/PGPASSWORD to the erp_app role from step 2
npm start
```

The server listens on `PORT` (default 4000) and serves both the REST API
(`/api/...`) and the frontend (`public/`) on the same origin — the frontend
calls the API via relative paths, so no CORS configuration is needed.

## API surface

- `GET /api/dashboard/summary`
- `GET /api/setup/{categories,families,types,materials,cert-types}` (+ `POST` to add)
- `GET /api/products?category=&family=&type=&status=&material=&q=&page=&pageSize=`
- `GET /api/products/:id`
- `GET /api/products/:id/{variants,documents,images,pricing,revisions,certificates,audit,attachments}`

`variants`, `pricing`, and `audit` are paginated (`page`, `pageSize` query params)
since a single product can have hundreds of variants and thousands of audit rows.

## Known data gaps (inherited from V1, not bugs)

Real migrated data will show empty **Documents**, **Attachments**, and
**Revision History** tabs for every product — the legacy system never tracked
these, so there is nothing to migrate. **Family** and **Type** show
"Unclassified (Category N)" because V1 had no sub-category granularity either;
both are real gaps to close with your product team, not something the schema
is missing (see `docs/product-management-architecture.md` for the full
analysis). Category *names* were also renamed post-migration from generic
placeholders to labels inferred from product-name patterns in the data —
treat these as a starting point for review, not a confirmed taxonomy.
