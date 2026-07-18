-- =====================================================================
-- MEDICAL DEVICE ERP — PRODUCT MANAGEMENT MODULE — SCHEMA V2
-- PostgreSQL 15+
-- Target scale: 100,000+ products, 5,000,000+ variants, 10y audit history
-- =====================================================================
-- Design principles:
--   1. Surrogate BIGINT identity PKs everywhere (headroom past 2^31).
--   2. Business keys (product_code, variant_code, udi_di, gtin) get
--      separate UNIQUE constraints — never used as PK.
--   3. Soft delete via deleted_at (nullable timestamptz); partial
--      unique indexes exclude soft-deleted rows so codes can be reused.
--   4. Every module gets its own schema so Inventory/Production/QC/
--      Sales/Purchasing/Regulatory can be added later without touching
--      product/variant tables — they just add FKs to product.variant_id.
--   5. Generic audit_log (core schema) covers all tables via triggers —
--      no per-table audit tables, so audit scales independently.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- fuzzy / partial-match search
CREATE EXTENSION IF NOT EXISTS btree_gin; -- composite GIN on scalar+jsonb

-- Schemas: one per future ERP module. Only `core` and `product` are
-- populated today; the rest are stubbed so future modules attach with
-- CREATE TABLE + FK only — no changes to product/variant ever required.
CREATE SCHEMA IF NOT EXISTS core;         -- cross-cutting shared masters
CREATE SCHEMA IF NOT EXISTS product;      -- this module
CREATE SCHEMA IF NOT EXISTS inventory;    -- future
CREATE SCHEMA IF NOT EXISTS production;   -- future (BOM, work orders)
CREATE SCHEMA IF NOT EXISTS routing;      -- future (operations, work centers)
CREATE SCHEMA IF NOT EXISTS quality;      -- future (QC/QA inspections)
CREATE SCHEMA IF NOT EXISTS regulatory;   -- future (beyond product.certification)
CREATE SCHEMA IF NOT EXISTS sales;        -- future
CREATE SCHEMA IF NOT EXISTS purchasing;   -- future
CREATE SCHEMA IF NOT EXISTS traceability; -- future (lot/serial/UDI-PI)

-- =====================================================================
-- 1. ENUM TYPES
-- =====================================================================
-- Lifecycle status is an ENUM because the value set is small, stable,
-- and order-dependent (draft -> active -> discontinued -> obsolete).
-- Anything that varies by geography/regulator (regulatory class,
-- certification body) is a LOOKUP TABLE instead — see section 3.

CREATE TYPE core.audit_action AS ENUM ('INSERT','UPDATE','DELETE');
CREATE TYPE core.document_status AS ENUM ('draft','in_review','approved','obsolete');

CREATE TYPE product.lifecycle_status AS ENUM
    ('draft','pending_approval','active','discontinued','obsolete');
CREATE TYPE product.variant_status AS ENUM
    ('draft','pending_approval','active','discontinued');
CREATE TYPE product.certification_status AS ENUM
    ('active','expired','revoked','pending_renewal');
CREATE TYPE product.price_type AS ENUM
    ('list_price','mrp','dealer_price','distributor_price','export_price','tender_price');
CREATE TYPE product.image_type AS ENUM
    ('primary','gallery','technical_drawing','packaging','three_sixty','label');
CREATE TYPE product.attribute_data_type AS ENUM
    ('numeric','text','boolean','lookup');

-- =====================================================================
-- 2. CORE SCHEMA — shared masters used across every future module
-- =====================================================================

CREATE TABLE core.app_user (
    user_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    username        VARCHAR(100) NOT NULL,
    full_name       VARCHAR(200) NOT NULL,
    email           VARCHAR(255),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_app_user_username UNIQUE (username)
);
COMMENT ON TABLE core.app_user IS
    'Minimal user stub so created_by/updated_by FKs resolve. Full identity/auth module is out of scope here.';

CREATE TABLE core.country (
    country_code    CHAR(2) PRIMARY KEY,          -- ISO 3166-1 alpha-2
    country_name    VARCHAR(100) NOT NULL
);

CREATE TABLE core.currency (
    currency_code   CHAR(3) PRIMARY KEY,           -- ISO 4217
    currency_name   VARCHAR(50) NOT NULL,
    symbol          VARCHAR(5),
    decimal_places  SMALLINT NOT NULL DEFAULT 2
);

CREATE TABLE core.uom (
    uom_code        VARCHAR(10) PRIMARY KEY,       -- e.g. MM, KG, EA
    uom_name        VARCHAR(50) NOT NULL,
    uom_type        VARCHAR(20) NOT NULL,          -- length | weight | count | volume
    base_uom_code   VARCHAR(10) REFERENCES core.uom(uom_code),
    conversion_factor NUMERIC(18,8)                -- to base_uom_code
);

CREATE TABLE core.document_type (
    document_type_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type_code       VARCHAR(30) NOT NULL,          -- IFU, DATASHEET, DRAWING, COA, CERTIFICATE
    type_name       VARCHAR(100) NOT NULL,
    CONSTRAINT uq_document_type_code UNIQUE (type_code)
);

-- Controlled-document register (Document Control / EDMS foundation,
-- Teamcenter-style): every certificate, IFU, drawing, datasheet is one
-- row here with its own revision + approval trail, independent of which
-- product/variant links to it via the join tables in section 6.
CREATE TABLE core.document (
    document_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_code     VARCHAR(50) NOT NULL,
    title             VARCHAR(300) NOT NULL,
    document_type_id  BIGINT NOT NULL REFERENCES core.document_type(document_type_id),
    revision_no       VARCHAR(20) NOT NULL DEFAULT 'A',
    status            core.document_status NOT NULL DEFAULT 'draft',
    effective_date    DATE,
    file_path         TEXT NOT NULL,                -- object storage key/URL
    mime_type         VARCHAR(100),
    file_size_bytes   BIGINT,
    checksum_sha256   CHAR(64),
    superseded_by_id  BIGINT REFERENCES core.document(document_id),
    uploaded_by       BIGINT REFERENCES core.app_user(user_id),
    uploaded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_document_code_revision UNIQUE (document_code, revision_no)
);
CREATE INDEX idx_document_type ON core.document(document_type_id);

-- Generic, partitioned audit trail. One row per changed table row per
-- change, populated by a single trigger function attached to any table
-- that needs history (product, variant, price, certification, revision).
-- Partitioned by month because this table grows unboundedly at
-- 100k-product / millions-of-variant scale.
CREATE TABLE core.audit_log (
    audit_id        BIGINT GENERATED ALWAYS AS IDENTITY,
    schema_name     TEXT NOT NULL,
    table_name      TEXT NOT NULL,
    record_pk       BIGINT NOT NULL,
    action          core.audit_action NOT NULL,
    changed_by      BIGINT REFERENCES core.app_user(user_id),
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    old_data        JSONB,
    new_data        JSONB,
    PRIMARY KEY (audit_id, changed_at)
) PARTITION BY RANGE (changed_at);

DO $$
DECLARE
    d DATE := date_trunc('month', now())::DATE;
BEGIN
    -- Pre-create a rolling 12 months of partitions starting this month.
    FOR i IN 0..11 LOOP
        EXECUTE format(
            'CREATE TABLE IF NOT EXISTS core.audit_log_%s PARTITION OF core.audit_log FOR VALUES FROM (%L) TO (%L);',
            to_char(d + (i || ' months')::INTERVAL, 'YYYY_MM'),
            d + (i || ' months')::INTERVAL,
            d + ((i + 1) || ' months')::INTERVAL
        );
    END LOOP;
END $$;
-- Safety net: catches any row outside the pre-created ranges instead of
-- erroring, e.g. if the monthly partition job falls behind.
CREATE TABLE core.audit_log_default PARTITION OF core.audit_log DEFAULT;
-- Operational note: run a scheduled job (pg_cron / pg_partman) to keep
-- creating the next month's partition ahead of time in production —
-- pg_partman is the recommended long-term approach over ad-hoc DDL.

CREATE INDEX idx_audit_log_table_record ON core.audit_log(table_name, record_pk, changed_at DESC);
CREATE INDEX idx_audit_log_changed_at_brin ON core.audit_log USING BRIN (changed_at);

CREATE OR REPLACE FUNCTION core.fn_audit_trigger() RETURNS TRIGGER AS $$
DECLARE
    v_user BIGINT;
BEGIN
    BEGIN
        v_user := current_setting('app.current_user_id', true)::BIGINT;
    EXCEPTION WHEN OTHERS THEN
        v_user := NULL;
    END;

    IF TG_OP = 'DELETE' THEN
        INSERT INTO core.audit_log(schema_name, table_name, record_pk, action, changed_by, old_data)
        VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, (to_jsonb(OLD)->>(TG_ARGV[0]))::BIGINT, 'DELETE', v_user, to_jsonb(OLD));
        RETURN OLD;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO core.audit_log(schema_name, table_name, record_pk, action, changed_by, old_data, new_data)
        VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, (to_jsonb(NEW)->>(TG_ARGV[0]))::BIGINT, 'UPDATE', v_user, to_jsonb(OLD), to_jsonb(NEW));
        RETURN NEW;
    ELSE
        INSERT INTO core.audit_log(schema_name, table_name, record_pk, action, changed_by, new_data)
        VALUES (TG_TABLE_SCHEMA, TG_TABLE_NAME, (to_jsonb(NEW)->>(TG_ARGV[0]))::BIGINT, 'INSERT', v_user, to_jsonb(NEW));
        RETURN NEW;
    END IF;
END;
$$ LANGUAGE plpgsql;
-- Usage: CREATE TRIGGER trg_audit AFTER INSERT OR UPDATE OR DELETE ON product.product
--        FOR EACH ROW EXECUTE FUNCTION core.fn_audit_trigger('product_id');
-- Attached to all tables listed in section 8 below.

-- =====================================================================
-- 3. LOOKUP TABLES (product schema) — small, stable, admin-maintained
-- =====================================================================

CREATE TABLE product.material (
    material_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    material_code     VARCHAR(30) NOT NULL,
    material_name     VARCHAR(150) NOT NULL,        -- e.g. "Stainless Steel 316L"
    material_standard VARCHAR(50),                   -- e.g. "ASTM F138 / ISO 5832-1"
    grade             VARCHAR(50),
    density_g_cm3     NUMERIC(6,3),
    is_biocompatible  BOOLEAN NOT NULL DEFAULT TRUE,
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_material_code UNIQUE (material_code)
);
-- NOTE: legacy variants.material_id has values {1,2,4} — id 3 never
-- appears. Seed rows 1,2,3,4 as placeholders during migration (see
-- 002_migration.sql) and rename via UPDATE once real material names
-- are confirmed with engineering/regulatory.

CREATE TABLE product.certification_type (
    cert_type_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    cert_code         VARCHAR(30) NOT NULL,          -- CE, CDSCO, FDA_510K, ISO13485, ANVISA...
    cert_name         VARCHAR(150) NOT NULL,
    issuing_country_code CHAR(2) REFERENCES core.country(country_code),
    description       TEXT,
    CONSTRAINT uq_certification_type_code UNIQUE (cert_code)
);
-- Replaces the hard-coded ce_certified / cdsco_certified boolean
-- columns on both products and variants. A new regulator (FDA, ANVISA,
-- BIS, UKCA...) is a new ROW here, never a new COLUMN or migration.

CREATE TABLE product.attribute (
    attribute_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    attribute_code    VARCHAR(50) NOT NULL,          -- DIAMETER_MM, LENGTH_MM, ANGLE_DEG, HOLE_COUNT, CANNULATED
    attribute_name    VARCHAR(100) NOT NULL,
    data_type         product.attribute_data_type NOT NULL,
    uom_code          VARCHAR(10) REFERENCES core.uom(uom_code),
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_attribute_code UNIQUE (attribute_code)
);
-- Defines the vocabulary of variant-distinguishing attributes (the
-- structured replacement for the free-text `size` column). See
-- product.type_attribute for which attributes apply to which product
-- type, and product.variant_attribute_value for the actual values.

-- =====================================================================
-- 4. PRODUCT HIERARCHY MASTERS — Category -> Family -> Type -> Product
-- =====================================================================

CREATE TABLE product.category (
    category_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category_code   VARCHAR(20) NOT NULL,
    category_name   VARCHAR(150) NOT NULL,
    description     TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order      INTEGER NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT uq_category_code UNIQUE (category_code)
);
-- Replaces legacy products.category_id (a bare integer FK with no
-- table behind it — 8 distinct values, no names anywhere in the data).

CREATE TABLE product.family (
    family_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    category_id     BIGINT NOT NULL REFERENCES product.category(category_id),
    family_code     VARCHAR(20) NOT NULL,
    family_name     VARCHAR(150) NOT NULL,          -- e.g. "Screws", "Plates", "Nails"
    description     TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_family_code UNIQUE (family_code)
);
CREATE INDEX idx_family_category ON product.family(category_id);

CREATE TABLE product.type (
    type_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    family_id       BIGINT NOT NULL REFERENCES product.family(family_id),
    type_code       VARCHAR(20) NOT NULL,
    type_name       VARCHAR(150) NOT NULL,          -- e.g. "Cortex Screw", "Locking Plate"
    description     TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    CONSTRAINT uq_type_code UNIQUE (type_code)
);
CREATE INDEX idx_type_family ON product.type(family_id);

-- product.type_attribute: the "variant configuration template" — which
-- attributes are configurable/required for every product of this type,
-- so the UI knows to prompt for Diameter+Length on a screw type but
-- Angle+Hole Count on a plate type, without hard-coded per-product logic.
CREATE TABLE product.type_attribute (
    type_attribute_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    type_id           BIGINT NOT NULL REFERENCES product.type(type_id),
    attribute_id      BIGINT NOT NULL REFERENCES product.attribute(attribute_id),
    is_required       BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order        INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT uq_type_attribute UNIQUE (type_id, attribute_id)
);

-- =====================================================================
-- 5. PRODUCT MASTER
-- =====================================================================

CREATE TABLE product.product (
    product_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_code        VARCHAR(30) NOT NULL,        -- business key, see barcode/code strategy doc
    legacy_product_code VARCHAR(30),                  -- verbatim V1 products.product_code (86 values were duplicated across distinct products in V1 — see migration notes); kept for traceability, not unique
    product_type_id     BIGINT NOT NULL REFERENCES product.type(type_id),
    product_name        VARCHAR(250) NOT NULL,
    short_description   VARCHAR(500),
    long_description    TEXT,
    base_uom_code       VARCHAR(10) REFERENCES core.uom(uom_code),

    -- ERP "item master" capability flags (SAP MARA-style) so Inventory,
    -- Production/BOM, Sales and Purchasing modules can filter the same
    -- product table by role instead of needing their own item master.
    is_purchased        BOOLEAN NOT NULL DEFAULT FALSE,
    is_manufactured      BOOLEAN NOT NULL DEFAULT TRUE,
    is_sellable          BOOLEAN NOT NULL DEFAULT TRUE,
    is_stockable          BOOLEAN NOT NULL DEFAULT TRUE,
    is_sterile           BOOLEAN NOT NULL DEFAULT FALSE,

    status               product.lifecycle_status NOT NULL DEFAULT 'draft',
    is_catalog_visible    BOOLEAN NOT NULL DEFAULT FALSE,   -- renamed from product_show; storefront/catalog visibility, independent of lifecycle status
    current_revision_id  BIGINT,                             -- FK added after product.revision exists (section 7)

    search_vector  TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(product_code,'')), 'A') ||
        setweight(to_tsvector('english', coalesce(product_name,'')), 'A') ||
        setweight(to_tsvector('english', coalesce(short_description,'')), 'B')
    ) STORED,

    remark               TEXT,
    created_by           BIGINT REFERENCES core.app_user(user_id),
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by            BIGINT REFERENCES core.app_user(user_id),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at            TIMESTAMPTZ,                         -- soft delete

    CONSTRAINT ck_product_status_visibility CHECK (
        NOT (status IN ('discontinued','obsolete') AND is_catalog_visible)
    )
);

-- Business key uniqueness excludes soft-deleted rows so a retired code
-- can be reused after obsolescence, while still being globally unique
-- among live products (fixes the 86 duplicate product_codes in V1).
CREATE UNIQUE INDEX uq_product_code_live ON product.product(product_code) WHERE deleted_at IS NULL;
CREATE INDEX idx_product_type ON product.product(product_type_id);
CREATE INDEX idx_product_legacy_code ON product.product(legacy_product_code);
CREATE INDEX idx_product_status ON product.product(status) WHERE deleted_at IS NULL;
CREATE INDEX idx_product_search_vector ON product.product USING GIN (search_vector);
CREATE INDEX idx_product_name_trgm ON product.product USING GIN (product_name gin_trgm_ops);

-- =====================================================================
-- 6. PRODUCT REVISION (Design History / ECN trail)
-- =====================================================================

CREATE TABLE product.revision (
    revision_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id        BIGINT NOT NULL REFERENCES product.product(product_id),
    revision_number   INTEGER NOT NULL,
    revision_code     VARCHAR(10) NOT NULL,          -- 'A','B','C'... derived from revision_number
    ecn_number        VARCHAR(50),                    -- Engineering Change Notice reference
    change_description TEXT NOT NULL,
    reason_for_change  TEXT,
    status            core.document_status NOT NULL DEFAULT 'draft',
    requested_by      BIGINT REFERENCES core.app_user(user_id),
    requested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    approved_by       BIGINT REFERENCES core.app_user(user_id),
    approved_at       TIMESTAMPTZ,
    effective_date    DATE,
    is_current        BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT uq_revision_number UNIQUE (product_id, revision_number)
);
CREATE UNIQUE INDEX uq_revision_current ON product.revision(product_id) WHERE is_current;
CREATE INDEX idx_revision_product ON product.revision(product_id);

ALTER TABLE product.product
    ADD CONSTRAINT fk_product_current_revision
    FOREIGN KEY (current_revision_id) REFERENCES product.revision(revision_id);

-- =====================================================================
-- 7. PRODUCT CERTIFICATION (replaces ce_certified/cdsco_certified columns)
-- =====================================================================

CREATE TABLE product.certification (
    product_cert_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id          BIGINT NOT NULL REFERENCES product.product(product_id),
    variant_id          BIGINT,                       -- NULL = applies to whole product; set = SKU-specific override; FK added in section 9 after variant exists
    cert_type_id        BIGINT NOT NULL REFERENCES product.certification_type(cert_type_id),
    certificate_number  VARCHAR(100),
    issuing_authority   VARCHAR(200),
    issue_date          DATE,
    expiry_date         DATE,
    status              product.certification_status NOT NULL DEFAULT 'active',
    document_id         BIGINT REFERENCES core.document(document_id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_certification_dates CHECK (expiry_date IS NULL OR expiry_date >= issue_date)
);
CREATE INDEX idx_certification_product ON product.certification(product_id);
CREATE INDEX idx_certification_expiry ON product.certification(expiry_date) WHERE status = 'active';

-- =====================================================================
-- 8. PRODUCT IMAGES (replaces single image_path column)
-- =====================================================================

CREATE TABLE product.image (
    image_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id       BIGINT NOT NULL REFERENCES product.product(product_id),
    variant_id       BIGINT,                          -- NULL = product-level image; set = variant-specific; FK added in section 9
    storage_key      TEXT NOT NULL,                    -- object storage path/URL (S3/Azure Blob/etc.)
    image_type       product.image_type NOT NULL DEFAULT 'gallery',
    alt_text         VARCHAR(250),
    sort_order       INTEGER NOT NULL DEFAULT 0,
    is_primary       BOOLEAN NOT NULL DEFAULT FALSE,
    uploaded_by      BIGINT REFERENCES core.app_user(user_id),
    uploaded_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_image_primary_per_product ON product.image(product_id) WHERE is_primary AND variant_id IS NULL;
CREATE INDEX idx_image_product ON product.image(product_id);
CREATE INDEX idx_image_variant ON product.image(variant_id) WHERE variant_id IS NOT NULL;

-- =====================================================================
-- 9. VARIANT MASTER (SKU level)
-- =====================================================================

CREATE TABLE product.variant (
    variant_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    product_id         BIGINT NOT NULL REFERENCES product.product(product_id),
    variant_code       VARCHAR(40) NOT NULL,           -- new globally-unique SKU, derived from product_code + legacy size_code
    legacy_size_code   VARCHAR(40),                    -- verbatim V1 variants.size_code (unique per product, but 18 collisions globally — see migration notes)
    material_id        BIGINT REFERENCES product.material(material_id),
    uom_code           VARCHAR(10) REFERENCES core.uom(uom_code),

    legacy_size_text   VARCHAR(200),                   -- verbatim copy of V1 free-text `size` column, preserved for display fallback / audit
    attributes         JSONB NOT NULL DEFAULT '{}',     -- fast-read structured attributes, e.g. {"diameter_mm":6,"length_mm":40}

    udi_di             VARCHAR(30),                     -- UDI Device Identifier (static part; PI/lot/serial live in traceability module)
    gtin               VARCHAR(14),
    barcode_value      VARCHAR(50),

    status              product.variant_status NOT NULL DEFAULT 'draft',
    is_catalog_visible   BOOLEAN NOT NULL DEFAULT FALSE,   -- renamed from variant_show

    search_vector  TSVECTOR GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', coalesce(variant_code,'')), 'A') ||
        setweight(to_tsvector('simple', coalesce(legacy_size_text,'')), 'B')
    ) STORED,

    created_by         BIGINT REFERENCES core.app_user(user_id),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by          BIGINT REFERENCES core.app_user(user_id),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_variant_code_live ON product.variant(variant_code) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_variant_udi_di ON product.variant(udi_di) WHERE udi_di IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_variant_gtin ON product.variant(gtin) WHERE gtin IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX uq_variant_barcode ON product.variant(barcode_value) WHERE barcode_value IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX idx_variant_product_status ON product.variant(product_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_variant_material ON product.variant(material_id);
CREATE INDEX idx_variant_legacy_code ON product.variant(legacy_size_code);
CREATE INDEX idx_variant_attributes_gin ON product.variant USING GIN (attributes jsonb_path_ops);
CREATE INDEX idx_variant_search_vector ON product.variant USING GIN (search_vector);

ALTER TABLE product.certification
    ADD CONSTRAINT fk_certification_variant FOREIGN KEY (variant_id) REFERENCES product.variant(variant_id);
ALTER TABLE product.image
    ADD CONSTRAINT fk_image_variant FOREIGN KEY (variant_id) REFERENCES product.variant(variant_id);

-- Typed, queryable attribute values — complements the `attributes`
-- JSONB above. JSONB is fast for "give me everything about this SKU";
-- this EAV table is what you index/range-query/report on at scale
-- ("all variants with 4mm <= diameter <= 6mm"), and it enforces that
-- only attributes declared in product.type_attribute are captured.
CREATE TABLE product.variant_attribute_value (
    variant_attr_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    variant_id        BIGINT NOT NULL REFERENCES product.variant(variant_id),
    attribute_id      BIGINT NOT NULL REFERENCES product.attribute(attribute_id),
    value_numeric     NUMERIC(18,4),
    value_text        VARCHAR(200),
    value_boolean     BOOLEAN,
    CONSTRAINT uq_variant_attribute UNIQUE (variant_id, attribute_id)
);
CREATE INDEX idx_variant_attr_value_numeric ON product.variant_attribute_value(attribute_id, value_numeric);

-- =====================================================================
-- 10. VARIANT PRICE HISTORY (replaces flat price_inr/price_usd/mrp columns)
-- =====================================================================

CREATE TABLE product.variant_price (
    price_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    variant_id      BIGINT NOT NULL REFERENCES product.variant(variant_id),
    currency_code   CHAR(3) NOT NULL REFERENCES core.currency(currency_code),
    price_type      product.price_type NOT NULL,
    amount          NUMERIC(14,4) NOT NULL CHECK (amount >= 0),
    valid_from      DATE NOT NULL DEFAULT CURRENT_DATE,
    valid_to        DATE,
    is_current      BOOLEAN NOT NULL DEFAULT TRUE,
    created_by      BIGINT REFERENCES core.app_user(user_id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT ck_price_dates CHECK (valid_to IS NULL OR valid_to >= valid_from)
);
-- Only one "current" price per SKU/currency/price-type at a time.
CREATE UNIQUE INDEX uq_variant_price_current
    ON product.variant_price(variant_id, currency_code, price_type) WHERE is_current;
CREATE INDEX idx_variant_price_variant ON product.variant_price(variant_id, price_type, valid_from DESC);

-- =====================================================================
-- 11. RELATIONSHIP / JOIN TABLES — documents linked to product & variant
-- =====================================================================
-- Explicit join tables (not a polymorphic entity_type/entity_id column)
-- so every link is a real, indexable, FK-enforced relationship.

CREATE TABLE product.product_document (
    product_id   BIGINT NOT NULL REFERENCES product.product(product_id),
    document_id  BIGINT NOT NULL REFERENCES core.document(document_id),
    PRIMARY KEY (product_id, document_id)
);

CREATE TABLE product.variant_document (
    variant_id   BIGINT NOT NULL REFERENCES product.variant(variant_id),
    document_id  BIGINT NOT NULL REFERENCES core.document(document_id),
    PRIMARY KEY (variant_id, document_id)
);

-- =====================================================================
-- 12. AUDIT TRIGGERS — attach the generic function to every tracked table
-- =====================================================================

CREATE TRIGGER trg_audit_product AFTER INSERT OR UPDATE OR DELETE ON product.product
    FOR EACH ROW EXECUTE FUNCTION core.fn_audit_trigger('product_id');
CREATE TRIGGER trg_audit_variant AFTER INSERT OR UPDATE OR DELETE ON product.variant
    FOR EACH ROW EXECUTE FUNCTION core.fn_audit_trigger('variant_id');
CREATE TRIGGER trg_audit_variant_price AFTER INSERT OR UPDATE OR DELETE ON product.variant_price
    FOR EACH ROW EXECUTE FUNCTION core.fn_audit_trigger('price_id');
CREATE TRIGGER trg_audit_certification AFTER INSERT OR UPDATE OR DELETE ON product.certification
    FOR EACH ROW EXECUTE FUNCTION core.fn_audit_trigger('product_cert_id');
CREATE TRIGGER trg_audit_revision AFTER INSERT OR UPDATE OR DELETE ON product.revision
    FOR EACH ROW EXECUTE FUNCTION core.fn_audit_trigger('revision_id');

-- =====================================================================
-- 13. updated_at maintenance trigger (generic, reused everywhere)
-- =====================================================================

CREATE OR REPLACE FUNCTION core.fn_set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_touch_product BEFORE UPDATE ON product.product
    FOR EACH ROW EXECUTE FUNCTION core.fn_set_updated_at();
CREATE TRIGGER trg_touch_variant BEFORE UPDATE ON product.variant
    FOR EACH ROW EXECUTE FUNCTION core.fn_set_updated_at();
