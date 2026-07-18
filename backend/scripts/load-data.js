#!/usr/bin/env node
// Cross-platform (Windows/macOS/Linux) loader: re-encodes products.csv /
// variants.csv from Windows-1252, stages them, applies the schema if
// missing, and runs the V1 -> V2 migration.
//
// Usage (PowerShell or cmd):
//   set PRODUCTS_CSV=C:\path\products.csv
//   set VARIANTS_CSV=C:\path\variants.csv
//   node scripts/load-data.js
//
// Usage (bash):
//   PRODUCTS_CSV=/path/products.csv VARIANTS_CSV=/path/variants.csv node scripts/load-data.js

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const iconv = require("iconv-lite");
const { parse } = require("csv-parse/sync");

const PRODUCTS_CSV = process.env.PRODUCTS_CSV;
const VARIANTS_CSV = process.env.VARIANTS_CSV;
if (!PRODUCTS_CSV || !VARIANTS_CSV) {
  console.error("Set PRODUCTS_CSV and VARIANTS_CSV environment variables to the CSV file paths.");
  process.exit(1);
}

const ROOT_DIR = path.join(__dirname, "..", "..");

function readCsvWin1252(filePath) {
  const buf = fs.readFileSync(filePath);
  const text = iconv.decode(buf, "win1252");
  return parse(text, { columns: true, skip_empty_lines: true });
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function insertRows(client, table, columns, rows) {
  if (!rows.length) return;
  for (const batch of chunk(rows, 500)) {
    const values = [];
    const placeholders = batch.map((row, i) => {
      const base = i * columns.length;
      columns.forEach((col) => values.push(row[col] === "" ? null : row[col]));
      return "(" + columns.map((_, j) => "$" + (base + j + 1)).join(",") + ")";
    });
    await client.query(
      `INSERT INTO ${table} (${columns.join(",")}) VALUES ${placeholders.join(",")}`,
      values
    );
  }
}

async function main() {
  const client = new Client({
    host: process.env.PGHOST || "127.0.0.1",
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE || "product_management",
    user: process.env.PGUSER || "postgres",
    password: process.env.PGPASSWORD || "postgres",
  });
  await client.connect();

  try {
    console.log("Reading and re-encoding CSVs…");
    const products = readCsvWin1252(PRODUCTS_CSV);
    const variants = readCsvWin1252(VARIANTS_CSV);
    console.log(`  products.csv: ${products.length} rows`);
    console.log(`  variants.csv: ${variants.length} rows`);

    const schemaCheck = await client.query(
      "SELECT 1 FROM pg_namespace WHERE nspname = 'product'"
    );
    if (schemaCheck.rowCount === 0) {
      console.log("Applying schema (sql/001_schema_v2.sql)…");
      const schemaSql = fs.readFileSync(path.join(ROOT_DIR, "sql", "001_schema_v2.sql"), "utf-8");
      await client.query(schemaSql);
    } else {
      console.log("Schema already present, skipping.");
    }

    console.log("Creating staging tables…");
    await client.query(`
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
    `);

    console.log("Loading products…");
    await insertRows(client, "public.products",
      ["product_id", "product_name", "product_code", "category_id", "image_path", "product_show",
       "ce_certified", "cdsco_certified", "product_sterile", "is_active", "remark", "created_by_user_id"],
      products);

    console.log("Loading variants…");
    await insertRows(client, "public.variants",
      ["variant_id", "product_id", "product_code", "size_code", "udi_number", "material_id", "size",
       "price_inr", "price_usd", "mrp", "variant_show", "ce_certified", "cdsco_certified", "created_by_user_id"],
      variants);

    console.log("Running V1 -> V2 migration (sql/002_migration_v1_to_v2.sql)…");
    const migrationSql = fs.readFileSync(path.join(ROOT_DIR, "sql", "002_migration_v1_to_v2.sql"), "utf-8");
    await client.query(migrationSql);

    const counts = await client.query(
      "SELECT (SELECT count(*) FROM product.product) AS products, (SELECT count(*) FROM product.variant) AS variants"
    );
    console.log("Done. Row counts:", counts.rows[0]);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Load failed:", err.message);
  process.exit(1);
});
