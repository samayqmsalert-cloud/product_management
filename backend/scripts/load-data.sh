#!/usr/bin/env bash
# Loads products.csv / variants.csv into the V2 schema.
#
# Usage:
#   PRODUCTS_CSV=/path/to/products.csv VARIANTS_CSV=/path/to/variants.csv \
#     PGHOST=127.0.0.1 PGDATABASE=product_management PGUSER=erp_app PGPASSWORD=... \
#     ./scripts/load-data.sh
#
# Requires: psql, iconv. Run once against a fresh database that already
# has sql/001_schema_v2.sql applied (this script applies it if missing).

set -euo pipefail

PRODUCTS_CSV="${PRODUCTS_CSV:?Set PRODUCTS_CSV to the path of products.csv}"
VARIANTS_CSV="${VARIANTS_CSV:?Set VARIANTS_CSV to the path of variants.csv}"
PGHOST="${PGHOST:-127.0.0.1}"
PGPORT="${PGPORT:-5432}"
PGDATABASE="${PGDATABASE:-product_management}"
PGUSER="${PGUSER:-erp_app}"
export PGPASSWORD="${PGPASSWORD:-erp_app_dev_password}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

echo "Re-encoding CSVs to UTF-8 (source files are commonly Windows-1252)…"
iconv -f WINDOWS-1252 -t UTF-8//TRANSLIT "$PRODUCTS_CSV" -o "$WORKDIR/products_utf8.csv"
iconv -f WINDOWS-1252 -t UTF-8//TRANSLIT "$VARIANTS_CSV" -o "$WORKDIR/variants_utf8.csv"

PSQL="psql -h $PGHOST -p $PGPORT -U $PGUSER -d $PGDATABASE -v ON_ERROR_STOP=1"

echo "Applying schema (idempotent skip if already applied)…"
$PSQL -c "SELECT 1 FROM pg_namespace WHERE nspname = 'product'" | grep -q 1 \
  || $PSQL -f "$ROOT_DIR/sql/001_schema_v2.sql"

echo "Creating legacy staging tables and loading CSVs…"
$PSQL <<SQL
CREATE TABLE IF NOT EXISTS public.products (
    product_id INT, product_name TEXT, product_code TEXT, category_id INT,
    image_path TEXT, product_show TEXT, ce_certified TEXT, cdsco_certified TEXT,
    product_sterile TEXT, is_active TEXT, remark TEXT, created_by_user_id INT
);
CREATE TABLE IF NOT EXISTS public.variants (
    variant_id INT, product_id INT, product_code TEXT, size_code TEXT, udi_number TEXT,
    material_id TEXT, size TEXT, price_inr TEXT, price_usd TEXT, mrp TEXT,
    variant_show TEXT, ce_certified TEXT, cdsco_certified TEXT, created_by_user_id INT
);
TRUNCATE public.products, public.variants;
SQL
$PSQL -c "\\copy public.products FROM '$WORKDIR/products_utf8.csv' WITH (FORMAT csv, HEADER true)"
$PSQL -c "\\copy public.variants FROM '$WORKDIR/variants_utf8.csv' WITH (FORMAT csv, HEADER true)"

echo "Running V1 -> V2 migration…"
$PSQL -f "$ROOT_DIR/sql/002_migration_v1_to_v2.sql"

echo "Done. Row counts:"
$PSQL -c "SELECT (SELECT count(*) FROM product.product) AS products, (SELECT count(*) FROM product.variant) AS variants;"
