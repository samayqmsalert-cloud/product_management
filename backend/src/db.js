const { Pool } = require("pg");

const pool = new Pool({
  host: process.env.PGHOST || "127.0.0.1",
  port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE || "product_management",
  user: process.env.PGUSER || "erp_app",
  password: process.env.PGPASSWORD || "erp_app_dev_password",
  max: 10,
});

module.exports = { pool, query: (text, params) => pool.query(text, params) };
