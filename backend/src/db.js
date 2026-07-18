const { Pool } = require("pg");

// DATABASE_URL (e.g. Render/Heroku-style managed Postgres) takes priority
// over discrete PG* vars, which remain the default for local development.
const poolConfig = process.env.DATABASE_URL
  ? {
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
      max: 10,
    }
  : {
      host: process.env.PGHOST || "127.0.0.1",
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || "product_management",
      user: process.env.PGUSER || "erp_app",
      password: process.env.PGPASSWORD || "erp_app_dev_password",
      ssl: process.env.PGSSL === "true" ? { rejectUnauthorized: false } : false,
      max: 10,
    };

const pool = new Pool(poolConfig);

module.exports = { pool, query: (text, params) => pool.query(text, params) };
