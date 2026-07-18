const express = require("express");
const { query } = require("../db");

const router = express.Router();

router.get("/summary", async (req, res, next) => {
  try {
    const [totals, byCategory, expiring, recentAudit] = await Promise.all([
      query(`
        SELECT
          (SELECT count(*) FROM product.product WHERE deleted_at IS NULL) AS product_count,
          (SELECT count(*) FROM product.variant WHERE deleted_at IS NULL) AS variant_count,
          (SELECT count(*) FROM product.product WHERE deleted_at IS NULL AND status = 'active') AS active_count,
          (SELECT count(*) FROM product.product WHERE deleted_at IS NULL AND is_sterile) AS sterile_count
      `),
      query(`
        SELECT c.category_id AS id, c.category_name AS name, count(p.product_id) AS count
        FROM product.category c
        LEFT JOIN product.family f ON f.category_id = c.category_id
        LEFT JOIN product.type t ON t.family_id = f.family_id
        LEFT JOIN product.product p ON p.product_type_id = t.type_id AND p.deleted_at IS NULL
        GROUP BY c.category_id, c.category_name, c.sort_order
        ORDER BY c.sort_order
      `),
      query(`
        SELECT p.product_id AS "productId", p.product_code AS "productCode", p.product_name AS "productName",
               ct.cert_code AS "certCode", ct.cert_name AS "certName",
               cert.expiry_date AS "expiryDate",
               (cert.expiry_date - CURRENT_DATE) AS "daysLeft"
        FROM product.certification cert
        JOIN product.product p ON p.product_id = cert.product_id
        JOIN product.certification_type ct ON ct.cert_type_id = cert.cert_type_id
        WHERE cert.status = 'active' AND cert.variant_id IS NULL
          AND cert.expiry_date IS NOT NULL
          AND cert.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + INTERVAL '120 days'
        ORDER BY cert.expiry_date ASC
        LIMIT 8
      `),
      query(`
        SELECT a.table_name AS "tableName", a.action, a.changed_at AS "changedAt",
               p.product_id AS "productId", p.product_code AS "productCode", p.product_name AS "productName"
        FROM core.audit_log a
        JOIN product.product p ON p.product_id = a.record_pk AND a.table_name = 'product'
        ORDER BY a.changed_at DESC
        LIMIT 6
      `),
    ]);

    res.json({
      totals: {
        products: Number(totals.rows[0].product_count),
        variants: Number(totals.rows[0].variant_count),
        active: Number(totals.rows[0].active_count),
        sterile: Number(totals.rows[0].sterile_count),
      },
      byCategory: byCategory.rows.map((r) => ({ id: r.id, name: r.name, count: Number(r.count) })),
      expiringCertifications: expiring.rows,
      recentActivity: recentAudit.rows,
    });
  } catch (e) { next(e); }
});

module.exports = router;
