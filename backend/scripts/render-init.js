#!/usr/bin/env node
// One-time initialization for a fresh managed Postgres instance (e.g. Render's
// initialDeployHook): applies the V2 schema, then restores the pre-migrated
// seed data (seed/seed_data.sql — the real products.csv/variants.csv already
// run through sql/002_migration_v1_to_v2.sql). Safe to re-run: skips work
// that's already done instead of erroring on a second deploy.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const ROOT_DIR = path.join(__dirname, "..", "..");

// pg_dump's plain-SQL output includes psql-only meta-commands (\restrict /
// \unrestrict, added in newer Postgres versions as a safety marker) that a
// raw driver connection can't execute — strip any line starting with '\'.
function stripPsqlMetaCommands(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n");
}

async function main() {
  const clientConfig = process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } }
    : {
        host: process.env.PGHOST || "127.0.0.1",
        port: Number(process.env.PGPORT || 5432),
        database: process.env.PGDATABASE || "product_management",
        user: process.env.PGUSER || "postgres",
        password: process.env.PGPASSWORD || "postgres",
      };
  const client = new Client(clientConfig);
  await client.connect();

  try {
    const schemaCheck = await client.query("SELECT 1 FROM pg_namespace WHERE nspname = 'product'");
    if (schemaCheck.rowCount === 0) {
      console.log("Applying schema (sql/001_schema_v2.sql)…");
      await client.query(fs.readFileSync(path.join(ROOT_DIR, "sql", "001_schema_v2.sql"), "utf-8"));
    } else {
      console.log("Schema already present, skipping.");
    }

    const dataCheck = await client.query("SELECT count(*) AS n FROM product.product");
    if (Number(dataCheck.rows[0].n) === 0) {
      console.log("Restoring seed data (seed/seed_data.sql)…");
      const seedSql = stripPsqlMetaCommands(
        fs.readFileSync(path.join(ROOT_DIR, "backend", "seed", "seed_data.sql"), "utf-8")
      );
      await client.query(seedSql);
    } else {
      console.log(`product.product already has ${dataCheck.rows[0].n} rows, skipping seed restore.`);
    }

    const counts = await client.query(
      "SELECT (SELECT count(*) FROM product.product) AS products, (SELECT count(*) FROM product.variant) AS variants"
    );
    console.log("Ready. Row counts:", counts.rows[0]);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error("Init failed:", err.message);
  process.exit(1);
});
