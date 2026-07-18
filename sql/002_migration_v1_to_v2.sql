-- =====================================================================
-- MIGRATION: legacy public.products / public.variants  ->  schema V2
-- Run after 001_schema_v2.sql. Assumes the legacy tables still exist
-- with exactly the columns present in products.csv / variants.csv.
-- Wrap in a transaction so a failure rolls back cleanly.
-- =====================================================================
BEGIN;

-- ---------------------------------------------------------------
-- STEP 0 — seed the small reference masters needed for FKs to resolve
-- ---------------------------------------------------------------
INSERT INTO core.app_user(user_id, username, full_name) OVERRIDING SYSTEM VALUE
    VALUES (1, 'legacy_system', 'Legacy Data Migration')
    ON CONFLICT (username) DO NOTHING;
SELECT setval(pg_get_serial_sequence('core.app_user','user_id'), GREATEST((SELECT max(user_id) FROM core.app_user), 1));

INSERT INTO core.currency(currency_code, currency_name, symbol, decimal_places) VALUES
    ('INR','Indian Rupee','₹',2),
    ('USD','US Dollar','$',2)
ON CONFLICT DO NOTHING;

INSERT INTO core.uom(uom_code, uom_name, uom_type) VALUES
    ('MM','Millimeter','length'),
    ('EA','Each','count')
ON CONFLICT DO NOTHING;

INSERT INTO core.document_type(type_code, type_name) VALUES
    ('CERTIFICATE','Certificate'), ('IFU','Instructions For Use'),
    ('DATASHEET','Datasheet'), ('DRAWING','Technical Drawing'), ('COA','Certificate of Analysis')
ON CONFLICT DO NOTHING;

INSERT INTO product.certification_type(cert_code, cert_name) VALUES
    ('CE','CE Marking (EU MDR)'),
    ('CDSCO','CDSCO Registration (India)')
ON CONFLICT DO NOTHING;

-- material_id in legacy variants has observed values {1,2,4} — id 3
-- never appears (gap in the source system). Seed 1-4 as placeholders;
-- rename material_name to the real specification once confirmed with
-- engineering (V1 never stored a material name anywhere).
INSERT INTO product.material(material_id, material_code, material_name) OVERRIDING SYSTEM VALUE VALUES
    (1, 'MAT-001', 'Material 1 — TO BE CONFIRMED'),
    (2, 'MAT-002', 'Material 2 — TO BE CONFIRMED'),
    (3, 'MAT-003', 'Material 3 — TO BE CONFIRMED (unused in legacy data)'),
    (4, 'MAT-004', 'Material 4 — TO BE CONFIRMED')
ON CONFLICT (material_id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('product.material','material_id'), GREATEST((SELECT max(material_id) FROM product.material), 1));

-- Category names were never stored in V1 (products.category_id is a
-- bare integer with no lookup table anywhere). Seed placeholders for
-- the 8 observed IDs; rename once the client confirms real category
-- names (e.g. Trauma, Spine, CMF, Sports Medicine...).
INSERT INTO product.category(category_id, category_code, category_name) OVERRIDING SYSTEM VALUE
    SELECT DISTINCT category_id, 'CAT-' || category_id, 'Category ' || category_id || ' — TO BE RENAMED'
    FROM public.products
    ON CONFLICT (category_id) DO NOTHING;
SELECT setval(pg_get_serial_sequence('product.category','category_id'), GREATEST((SELECT max(category_id) FROM product.category), 1));

-- V1 has no Family/Type granularity at all. Bridge with one default
-- Family and one default Type per Category so every migrated product
-- has a valid product_type_id. This is a DATA COMPLETION task for the
-- client's product team post-migration, not a schema gap — the tables
-- and constraints already support the full 5-level hierarchy.
INSERT INTO product.family(category_id, family_code, family_name)
    SELECT category_id, 'FAM-' || category_id || '-DEFAULT', 'Unclassified (Category ' || category_id || ')'
    FROM product.category
    ON CONFLICT (family_code) DO NOTHING;

INSERT INTO product.type(family_id, type_code, type_name)
    SELECT f.family_id, 'TYP-' || f.category_id || '-DEFAULT', 'Unclassified (Category ' || f.category_id || ')'
    FROM product.family f
    ON CONFLICT (type_code) DO NOTHING;

-- ---------------------------------------------------------------
-- STEP 1 — products: dedupe product_code, load into product.product
-- ---------------------------------------------------------------
-- V1's product_code is NOT unique (83 codes shared by 2-3 distinct
-- products, e.g. base device / HA-coated / sterile-packed variants
-- that were modeled as separate *products* instead of variant
-- attributes). We preserve the original value in legacy_product_code
-- and mint a new, guaranteed-unique product_code by suffixing a letter
-- for every collision, ordered by product_id.
WITH ranked AS (
    SELECT p.*,
           row_number() OVER (PARTITION BY p.product_code ORDER BY p.product_id) AS rn,
           count(*)     OVER (PARTITION BY p.product_code) AS code_count
    FROM public.products p
)
INSERT INTO product.product (
    product_id, product_code, legacy_product_code, product_type_id, product_name,
    is_sterile, status, is_catalog_visible, remark, created_by
)
OVERRIDING SYSTEM VALUE
SELECT
    r.product_id,
    CASE WHEN r.code_count = 1 THEN r.product_code
         ELSE r.product_code || '-' || chr((64 + r.rn)::INT)  -- 501 -> 501-A, 501-B, ...
    END,
    r.product_code,
    t.type_id,
    r.product_name,
    (r.product_sterile = 'Yes'),
    CASE WHEN r.is_active = 'Yes' THEN 'active'::product.lifecycle_status ELSE 'discontinued'::product.lifecycle_status END,
    (r.is_active = 'Yes' AND r.product_show = 'Yes'),
    NULLIF(r.remark, ''),
    coalesce(r.created_by_user_id, 1)
FROM ranked r
JOIN product.category c ON c.category_id = r.category_id
JOIN product.type t ON t.type_code = 'TYP-' || c.category_id || '-DEFAULT';

SELECT setval(pg_get_serial_sequence('product.product','product_id'), GREATEST((SELECT max(product_id) FROM product.product), 1));

-- Product-level certifications: a row means "certified"; absence means
-- "not (yet) certified" — replaces the two boolean columns and scales
-- to any future regulator without a schema change.
INSERT INTO product.certification (product_id, cert_type_id, status)
SELECT p.product_id, ct.cert_type_id, 'active'
FROM public.products lp
JOIN product.product p ON p.product_id = lp.product_id
JOIN product.certification_type ct ON ct.cert_code = 'CE'
WHERE lp.ce_certified = 'Yes';

INSERT INTO product.certification (product_id, cert_type_id, status)
SELECT p.product_id, ct.cert_type_id, 'active'
FROM public.products lp
JOIN product.product p ON p.product_id = lp.product_id
JOIN product.certification_type ct ON ct.cert_code = 'CDSCO'
WHERE lp.cdsco_certified = 'Yes';

-- Single legacy image_path -> first gallery image, marked primary.
INSERT INTO product.image (product_id, storage_key, image_type, is_primary)
SELECT p.product_id, lp.image_path, 'primary', TRUE
FROM public.products lp
JOIN product.product p ON p.product_id = lp.product_id
WHERE lp.image_path IS NOT NULL AND lp.image_path <> '';

-- ---------------------------------------------------------------
-- STEP 2 — variants
-- ---------------------------------------------------------------
-- variant_code must be globally unique (V1's size_code repeats 18x
-- across different products). Deriving it from the now-unique
-- product_code + legacy size_code guarantees global uniqueness without
-- inventing a new numbering scheme mid-migration.
INSERT INTO product.variant (
    variant_id, product_id, variant_code, legacy_size_code, material_id,
    legacy_size_text, udi_di, status, is_catalog_visible, created_by
)
OVERRIDING SYSTEM VALUE
SELECT
    v.variant_id,
    p.product_id,
    p.product_code || '-' || v.size_code,
    v.size_code,
    NULLIF(v.material_id, 'NULL')::BIGINT,
    v.size,
    v.udi_number,
    CASE WHEN v.variant_show = 'Yes' THEN 'active'::product.variant_status ELSE 'discontinued'::product.variant_status END,
    (v.variant_show = 'Yes'),
    coalesce(v.created_by_user_id, 1)
FROM public.variants v
JOIN product.product p ON p.product_id = v.product_id;

SELECT setval(pg_get_serial_sequence('product.variant','variant_id'), GREATEST((SELECT max(variant_id) FROM product.variant), 1));

-- Variant-level certification OVERRIDES only, i.e. rows where the
-- variant's flag genuinely disagrees with its parent product's flag.
-- Profiling the actual data found 1,501 such rows (~6% of variants),
-- ALL in the direction "product is CDSCO-certified overall, but this
-- specific SKU is not" (e.g. a size/pack that hasn't cleared testing
-- yet) — the opposite direction never occurs. That's recorded as a
-- 'revoked' status row scoped to the variant, so a query that resolves
-- "is this SKU CDSCO certified" must check for a variant-scoped row
-- first and fall back to the product-level row — exactly the override
-- semantics product.certification.variant_id was designed for.
INSERT INTO product.certification (product_id, variant_id, cert_type_id, status)
SELECT p.product_id, va.variant_id, ct.cert_type_id, 'revoked'
FROM public.variants lv
JOIN public.products lp ON lp.product_id = lv.product_id
JOIN product.variant va ON va.variant_id = lv.variant_id
JOIN product.product p ON p.product_id = lv.product_id
JOIN product.certification_type ct ON ct.cert_code = 'CDSCO'
WHERE lv.cdsco_certified = 'No' AND lp.cdsco_certified = 'Yes';

-- CE never disagreed between product and variant in V1 (0 mismatches
-- observed), so it is deliberately NOT duplicated at the variant level
-- here — the product-level row in product.certification is the single
-- source of truth and variants inherit it.

-- Prices: one row per non-blank legacy price column, all inserted as
-- the current price effective from migration day. Blank source values
-- are simply skipped rather than stored as 0/NULL placeholders.
INSERT INTO product.variant_price (variant_id, currency_code, price_type, amount, valid_from, created_by)
SELECT v.variant_id, 'INR', 'list_price', lv.price_inr::NUMERIC, CURRENT_DATE, 1
FROM public.variants lv JOIN product.variant v ON v.variant_id = lv.variant_id
WHERE NULLIF(lv.price_inr, '') IS NOT NULL;

INSERT INTO product.variant_price (variant_id, currency_code, price_type, amount, valid_from, created_by)
SELECT v.variant_id, 'USD', 'list_price', lv.price_usd::NUMERIC, CURRENT_DATE, 1
FROM public.variants lv JOIN product.variant v ON v.variant_id = lv.variant_id
WHERE NULLIF(lv.price_usd, '') IS NOT NULL;

INSERT INTO product.variant_price (variant_id, currency_code, price_type, amount, valid_from, created_by)
SELECT v.variant_id, 'INR', 'mrp', lv.mrp::NUMERIC, CURRENT_DATE, 1
FROM public.variants lv JOIN product.variant v ON v.variant_id = lv.variant_id
WHERE NULLIF(lv.mrp, '') IS NOT NULL;

COMMIT;

-- ---------------------------------------------------------------
-- STEP 3 — post-migration verification (run manually, compare counts)
-- ---------------------------------------------------------------
-- SELECT (SELECT count(*) FROM public.products) AS legacy_products,
--        (SELECT count(*) FROM product.product) AS new_products;
-- SELECT (SELECT count(*) FROM public.variants) AS legacy_variants,
--        (SELECT count(*) FROM product.variant) AS new_variants;
-- Row counts on both sides must match 1:1 — this migration is a pure
-- reshape, it neither drops nor fans out source rows.
