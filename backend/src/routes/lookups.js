const express = require("express");
const { query } = require("../db");

const router = express.Router();

router.get("/categories", async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT category_id AS id, category_code AS code, category_name AS name FROM product.category WHERE is_active ORDER BY sort_order, category_name"
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.post("/categories", async (req, res, next) => {
  try {
    const { name, code } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const finalCode = code || name.slice(0, 3).toUpperCase() + "-" + Date.now().toString().slice(-4);
    const { rows } = await query(
      "INSERT INTO product.category (category_code, category_name) VALUES ($1, $2) RETURNING category_id AS id, category_code AS code, category_name AS name",
      [finalCode, name]
    );
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

router.get("/families", async (req, res, next) => {
  try {
    const { categoryId } = req.query;
    const params = [];
    let sql = `SELECT f.family_id AS id, f.category_id AS "categoryId", f.family_name AS name, c.category_name AS "categoryName"
               FROM product.family f JOIN product.category c ON c.category_id = f.category_id WHERE f.is_active`;
    if (categoryId) { params.push(categoryId); sql += ` AND f.category_id = $${params.length}`; }
    sql += " ORDER BY f.family_name";
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post("/families", async (req, res, next) => {
  try {
    const { name, categoryId } = req.body;
    if (!name || !categoryId) return res.status(400).json({ error: "name and categoryId are required" });
    const code = name.slice(0, 3).toUpperCase() + "-" + Date.now().toString().slice(-4);
    const { rows } = await query(
      "INSERT INTO product.family (category_id, family_code, family_name) VALUES ($1, $2, $3) RETURNING family_id AS id, category_id AS \"categoryId\", family_name AS name",
      [categoryId, code, name]
    );
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

router.get("/types", async (req, res, next) => {
  try {
    const { familyId } = req.query;
    const params = [];
    let sql = `SELECT t.type_id AS id, t.family_id AS "familyId", t.type_name AS name, f.family_name AS "familyName"
               FROM product.type t JOIN product.family f ON f.family_id = t.family_id WHERE t.is_active`;
    if (familyId) { params.push(familyId); sql += ` AND t.family_id = $${params.length}`; }
    sql += " ORDER BY t.type_name";
    const { rows } = await query(sql, params);
    res.json(rows);
  } catch (e) { next(e); }
});

router.post("/types", async (req, res, next) => {
  try {
    const { name, familyId } = req.body;
    if (!name || !familyId) return res.status(400).json({ error: "name and familyId are required" });
    const code = name.slice(0, 3).toUpperCase() + "-" + Date.now().toString().slice(-4);
    const { rows } = await query(
      "INSERT INTO product.type (family_id, type_code, type_name) VALUES ($1, $2, $3) RETURNING type_id AS id, family_id AS \"familyId\", type_name AS name",
      [familyId, code, name]
    );
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

router.get("/materials", async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT material_id AS id, material_code AS code, material_name AS name, material_standard AS standard FROM product.material WHERE is_active ORDER BY material_name"
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.post("/materials", async (req, res, next) => {
  try {
    const { name, standard } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const code = "MAT-" + Date.now().toString().slice(-6);
    const { rows } = await query(
      "INSERT INTO product.material (material_code, material_name, material_standard) VALUES ($1, $2, $3) RETURNING material_id AS id, material_code AS code, material_name AS name, material_standard AS standard",
      [code, name, standard || null]
    );
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

router.get("/cert-types", async (req, res, next) => {
  try {
    const { rows } = await query(
      "SELECT cert_type_id AS id, cert_code AS code, cert_name AS name FROM product.certification_type ORDER BY cert_name"
    );
    res.json(rows);
  } catch (e) { next(e); }
});

router.post("/cert-types", async (req, res, next) => {
  try {
    const { name, code } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    const finalCode = code || name.slice(0, 6).toUpperCase().replace(/\s+/g, "_");
    const { rows } = await query(
      "INSERT INTO product.certification_type (cert_code, cert_name) VALUES ($1, $2) RETURNING cert_type_id AS id, cert_code AS code, cert_name AS name",
      [finalCode, name]
    );
    res.status(201).json(rows[0]);
  } catch (e) { next(e); }
});

module.exports = router;
