# Product Management Backend

REST API + static frontend for the Product Management module, backed by the
`sql/001_schema_v2.sql` schema.

## Windows setup (PowerShell)

1. **Install Node.js and PostgreSQL** (skip if already installed):

   ```powershell
   winget install OpenJS.NodeJS.LTS
   winget install PostgreSQL.PostgreSQL.17
   ```

   The PostgreSQL installer asks you to set a password for the `postgres`
   superuser during setup — remember it, you'll use it below. It also adds
   `psql` to a folder like `C:\Program Files\PostgreSQL\17\bin`; if `psql`
   isn't recognized afterward, either open a new terminal or add that folder
   to your `PATH`.

2. **Clone the repo and install dependencies**:

   ```powershell
   git clone <your-repo-url>
   cd product_management\backend
   npm install
   ```

3. **Create the database and apply the schema**:

   ```powershell
   $env:PGPASSWORD = "<the postgres password you set during install>"
   createdb -U postgres product_management
   psql -U postgres -d product_management -f ..\sql\001_schema_v2.sql
   ```

4. **Create a least-privilege app role**:

   ```powershell
   psql -U postgres -d product_management -c "CREATE ROLE erp_app LOGIN PASSWORD 'change-me'; GRANT USAGE ON SCHEMA core, product TO erp_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, product TO erp_app; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, product TO erp_app;"
   ```

5. **Load your CSVs** — this step is a cross-platform Node script (no bash/
   iconv/WSL needed), so it runs the same way on Windows:

   ```powershell
   $env:PRODUCTS_CSV = "C:\path\to\products.csv"
   $env:VARIANTS_CSV = "C:\path\to\variants.csv"
   $env:PGUSER = "postgres"
   $env:PGPASSWORD = "<the postgres password you set during install>"
   $env:PGDATABASE = "product_management"
   node scripts\load-data.js
   ```

   It re-encodes the CSVs from Windows-1252 to UTF-8, stages them, and runs
   `sql/002_migration_v1_to_v2.sql`. Expect to see `Done. Row counts: { products: '1469', variants: '25358' }`
   (or your own counts if your CSVs differ).

6. **Configure and run the API**:

   ```powershell
   Copy-Item .env.example .env
   # edit .env: set PGUSER=erp_app and PGPASSWORD=change-me (the role from step 4)
   npm start
   ```

   Then open **http://localhost:4000** in your browser.

## macOS / Linux setup

Same steps, using your package manager (`brew install node postgresql` /
`apt install nodejs postgresql`) and either `scripts/load-data.js` (same as
above) or the bash equivalent `scripts/load-data.sh` (needs `iconv`, which
ships standard on macOS/Linux):

```bash
npm install
createdb product_management
psql -d product_management -f ../sql/001_schema_v2.sql
psql -d product_management -c "CREATE ROLE erp_app LOGIN PASSWORD 'change-me'; GRANT USAGE ON SCHEMA core, product TO erp_app; GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA core, product TO erp_app; GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA core, product TO erp_app;"
PRODUCTS_CSV=/path/to/products.csv VARIANTS_CSV=/path/to/variants.csv \
  PGUSER=postgres PGDATABASE=product_management node scripts/load-data.js
cp .env.example .env   # edit PGUSER/PGPASSWORD to the erp_app role
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
