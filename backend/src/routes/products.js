const express = require("express");
const { query } = require("../db");

const router = express.Router();

function pagination(req, defaultPageSize) {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const pageSize = Math.min(200, Math.max(1, parseInt(req.query.pageSize, 10) || defaultPageSize));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

// ---------------------------------------------------------------
// GET /api/products — paginated, filterable list
// ---------------------------------------------------------------
router.get("/", async (req, res, next) => {
  try {
    const { page, pageSize, offset } = pagination(req, 25);
    const { category, family, type, status, material, q } = req.query;
    const where = ["p.deleted_at IS NULL"];
    const params = [];

    if (category) { params.push(category); where.push(`c.category_id = $${params.length}`); }
    if (family) { params.push(family); where.push(`f.family_id = $${params.length}`); }
    if (type) { params.push(type); where.push(`t.type_id = $${params.length}`); }
    if (status) { params.push(status); where.push(`p.status = $${params.length}`); }
    if (material) {
      params.push(material);
      where.push(`EXISTS (SELECT 1 FROM product.variant v WHERE v.product_id = p.product_id AND v.deleted_at IS NULL AND v.material_id = $${params.length})`);
    }
    if (q) {
      params.push(`%${q}%`);
      const likeIdx = params.length;
      params.push(q);
      const tsIdx = params.length;
      where.push(`(p.product_code ILIKE $${likeIdx} OR p.product_name ILIKE $${likeIdx} OR p.search_vector @@ plainto_tsquery('simple', $${tsIdx}))`);
    }

    const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";

    const countSql = `
      SELECT count(*) AS total
      FROM product.product p
      JOIN product.type t ON t.type_id = p.product_type_id
      JOIN product.family f ON f.family_id = t.family_id
      JOIN product.category c ON c.category_id = f.category_id
      ${whereSql}
    `;
    const listParams = params.slice();
    listParams.push(pageSize, offset);
    const listSql = `
      SELECT p.product_id AS id, p.product_code AS code, p.legacy_product_code AS "legacyCode",
             p.product_name AS name, p.status, p.is_catalog_visible AS "catalogVisible",
             p.is_sterile AS "isSterile",
             c.category_name AS "categoryName", f.family_name AS "familyName", t.type_name AS "typeName",
             (SELECT count(*) FROM product.variant v WHERE v.product_id = p.product_id AND v.deleted_at IS NULL) AS "variantCount",
             (SELECT array_agg(DISTINCT m.material_name) FROM product.variant v2
                JOIN product.material m ON m.material_id = v2.material_id
                WHERE v2.product_id = p.product_id AND v2.deleted_at IS NULL) AS materials
      FROM product.product p
      JOIN product.type t ON t.type_id = p.product_type_id
      JOIN product.family f ON f.family_id = t.family_id
      JOIN product.category c ON c.category_id = f.category_id
      ${whereSql}
      ORDER BY p.product_code
      LIMIT $${listParams.length - 1} OFFSET $${listParams.length}
    `;

    const [countResult, listResult] = await Promise.all([
      query(countSql, params),
      query(listSql, listParams),
    ]);

    const total = Number(countResult.rows[0].total);
    res.json({
      data: listResult.rows.map((r) => ({ ...r, variantCount: Number(r.variantCount), materials: r.materials || [] })),
      page, pageSize, total, totalPages: Math.ceil(total / pageSize),
    });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------
// GET /api/products/:id — overview
// ---------------------------------------------------------------
router.get("/:id", async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT p.product_id AS id, p.product_code AS code, p.legacy_product_code AS "legacyCode",
             p.product_name AS name, p.short_description AS "shortDescription", p.long_description AS "longDescription",
             p.status, p.is_catalog_visible AS "catalogVisible", p.is_sterile AS "isSterile",
             p.is_purchased AS "isPurchased", p.is_manufactured AS "isManufactured",
             p.is_sellable AS "isSellable", p.is_stockable AS "isStockable",
             p.remark, p.created_at AS "createdAt", p.updated_at AS "updatedAt",
             c.category_id AS "categoryId", c.category_name AS "categoryName",
             f.family_id AS "familyId", f.family_name AS "familyName",
             t.type_id AS "typeId", t.type_name AS "typeName",
             rv.revision_code AS "currentRevisionCode"
      FROM product.product p
      JOIN product.type t ON t.type_id = p.product_type_id
      JOIN product.family f ON f.family_id = t.family_id
      JOIN product.category c ON c.category_id = f.category_id
      LEFT JOIN product.revision rv ON rv.revision_id = p.current_revision_id
      WHERE p.product_id = $1 AND p.deleted_at IS NULL
    `, [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: "Product not found" });
    res.json(rows[0]);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------
// GET /api/products/:id/variants
// ---------------------------------------------------------------
router.get("/:id/variants", async (req, res, next) => {
  try {
    const { page, pageSize, offset } = pagination(req, 20);
    const productId = req.params.id;

    const countResult = await query(
      "SELECT count(*) AS total FROM product.variant WHERE product_id = $1 AND deleted_at IS NULL",
      [productId]
    );
    const total = Number(countResult.rows[0].total);

    const { rows } = await query(`
      SELECT v.variant_id AS id, v.variant_code AS code, v.legacy_size_code AS "legacyCode",
             v.legacy_size_text AS "sizeText", v.udi_di AS udi, v.status,
             v.is_catalog_visible AS "catalogVisible",
             m.material_id AS "materialId", m.material_name AS "materialName",
             (SELECT vp.amount FROM product.variant_price vp
                WHERE vp.variant_id = v.variant_id AND vp.currency_code = 'INR' AND vp.price_type = 'list_price' AND vp.is_current
                ORDER BY vp.valid_from DESC LIMIT 1) AS "priceInr",
             EXISTS (SELECT 1 FROM product.certification cert WHERE cert.variant_id = v.variant_id AND cert.status = 'revoked') AS "hasCertOverride"
      FROM product.variant v
      LEFT JOIN product.material m ON m.material_id = v.material_id
      WHERE v.product_id = $1 AND v.deleted_at IS NULL
      ORDER BY v.variant_code
      LIMIT $2 OFFSET $3
    `, [productId, pageSize, offset]);

    res.json({ data: rows, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------
// GET /api/products/:id/documents
// ---------------------------------------------------------------
router.get("/:id/documents", async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT d.document_id AS id, d.document_code AS code, d.title, dt.type_name AS "typeName",
             d.revision_no AS "revisionNo", d.status, d.effective_date AS "effectiveDate"
      FROM product.product_document pd
      JOIN core.document d ON d.document_id = pd.document_id
      JOIN core.document_type dt ON dt.document_type_id = d.document_type_id
      WHERE pd.product_id = $1
      ORDER BY d.document_id
    `, [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------
// GET /api/products/:id/images
// ---------------------------------------------------------------
router.get("/:id/images", async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT image_id AS id, storage_key AS "storageKey", image_type AS "imageType", is_primary AS "isPrimary", sort_order AS "sortOrder"
      FROM product.image
      WHERE product_id = $1 AND variant_id IS NULL
      ORDER BY is_primary DESC, sort_order
    `, [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------
// GET /api/products/:id/pricing
// ---------------------------------------------------------------
router.get("/:id/pricing", async (req, res, next) => {
  try {
    const { page, pageSize, offset } = pagination(req, 20);
    const productId = req.params.id;

    const countResult = await query(`
      SELECT count(*) AS total FROM product.variant_price vp
      JOIN product.variant v ON v.variant_id = vp.variant_id
      WHERE v.product_id = $1
    `, [productId]);
    const total = Number(countResult.rows[0].total);

    const { rows } = await query(`
      SELECT vp.price_id AS id, v.variant_code AS "variantCode", vp.currency_code AS currency,
             vp.price_type AS "priceType", vp.amount, vp.valid_from AS "validFrom", vp.valid_to AS "validTo",
             vp.is_current AS "isCurrent"
      FROM product.variant_price vp
      JOIN product.variant v ON v.variant_id = vp.variant_id
      WHERE v.product_id = $1
      ORDER BY vp.is_current DESC, v.variant_code, vp.price_type
      LIMIT $2 OFFSET $3
    `, [productId, pageSize, offset]);

    res.json({ data: rows, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------
// GET /api/products/:id/revisions
// ---------------------------------------------------------------
router.get("/:id/revisions", async (req, res, next) => {
  try {
    const { rows } = await query(`
      SELECT revision_id AS id, revision_code AS code, ecn_number AS "ecnNumber",
             change_description AS "changeDescription", reason_for_change AS "reasonForChange",
             status, requested_by AS "requestedBy", approved_by AS "approvedBy",
             effective_date AS "effectiveDate", is_current AS "isCurrent"
      FROM product.revision
      WHERE product_id = $1
      ORDER BY revision_number DESC
    `, [req.params.id]);
    res.json(rows);
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------
// GET /api/products/:id/certificates
// ---------------------------------------------------------------
router.get("/:id/certificates", async (req, res, next) => {
  try {
    const productId = req.params.id;
    const [productLevel, variantOverrides] = await Promise.all([
      query(`
        SELECT cert.product_cert_id AS id, ct.cert_code AS "certCode", ct.cert_name AS "certName",
               cert.certificate_number AS "certificateNumber", cert.issuing_authority AS "issuingAuthority",
               cert.issue_date AS "issueDate", cert.expiry_date AS "expiryDate", cert.status,
               (cert.expiry_date - CURRENT_DATE) AS "daysLeft"
        FROM product.certification cert
        JOIN product.certification_type ct ON ct.cert_type_id = cert.cert_type_id
        WHERE cert.product_id = $1 AND cert.variant_id IS NULL
        ORDER BY cert.expiry_date NULLS LAST
      `, [productId]),
      query(`
        SELECT cert.product_cert_id AS id, v.variant_code AS "variantCode", ct.cert_code AS "certCode",
               ct.cert_name AS "certName", cert.status
        FROM product.certification cert
        JOIN product.certification_type ct ON ct.cert_type_id = cert.cert_type_id
        JOIN product.variant v ON v.variant_id = cert.variant_id
        WHERE cert.product_id = $1 AND cert.variant_id IS NOT NULL
        ORDER BY v.variant_code
      `, [productId]),
    ]);
    res.json({ productLevel: productLevel.rows, variantOverrides: variantOverrides.rows });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------
// GET /api/products/:id/audit
// ---------------------------------------------------------------
router.get("/:id/audit", async (req, res, next) => {
  try {
    const { page, pageSize, offset } = pagination(req, 20);
    const productId = req.params.id;

    const sqlCore = `
      WITH my_variants AS (SELECT variant_id FROM product.variant WHERE product_id = $1),
           my_prices AS (SELECT price_id FROM product.variant_price WHERE variant_id IN (SELECT variant_id FROM my_variants)),
           my_certs AS (SELECT product_cert_id FROM product.certification WHERE product_id = $1),
           relevant AS (
             SELECT * FROM core.audit_log WHERE table_name = 'product' AND record_pk = $1::bigint
             UNION ALL
             SELECT * FROM core.audit_log WHERE table_name = 'variant' AND record_pk IN (SELECT variant_id FROM my_variants)
             UNION ALL
             SELECT * FROM core.audit_log WHERE table_name = 'variant_price' AND record_pk IN (SELECT price_id FROM my_prices)
             UNION ALL
             SELECT * FROM core.audit_log WHERE table_name = 'certification' AND record_pk IN (SELECT product_cert_id FROM my_certs)
           )
    `;

    const countResult = await query(sqlCore + " SELECT count(*) AS total FROM relevant", [productId]);
    const total = Number(countResult.rows[0].total);

    const { rows } = await query(
      sqlCore + `
      SELECT table_name AS "tableName", record_pk AS "recordPk", action, changed_at AS "changedAt",
             old_data AS "oldData", new_data AS "newData"
      FROM relevant
      ORDER BY changed_at DESC
      LIMIT $2 OFFSET $3
    `, [productId, pageSize, offset]);

    res.json({ data: rows, page, pageSize, total, totalPages: Math.ceil(total / pageSize) });
  } catch (e) { next(e); }
});

// ---------------------------------------------------------------
// GET /api/products/:id/attachments
// ---------------------------------------------------------------
router.get("/:id/attachments", async (req, res, next) => {
  res.json([]);
});

module.exports = router;
