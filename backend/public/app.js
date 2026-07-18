(function () {
  "use strict";

  var state = {
    productFilters: { categoryId: null, familyId: null, typeId: null, status: "", material: "", q: "" },
    productPage: 1,
    selectedProductId: null,
    selectedTab: "overview",
    setupTab: "category",
    tabPage: {}, // per-tab pagination for variants/pricing/audit, keyed by tab name
    cache: { categories: null, materials: null, certTypes: null, families: {}, types: {} },
  };

  // ---------- helpers ----------
  function el(sel, root) { return (root || document).querySelector(sel); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function fmtMoney(amount, currency) {
    if (amount == null) return "—";
    var sym = currency === "USD" ? "$" : currency === "INR" ? "₹" : currency + " ";
    return sym + Number(amount).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtDate(d) {
    if (!d) return "—";
    var dt = new Date(d);
    if (isNaN(dt)) return d;
    return dt.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
  }
  function fmtDateTime(d) {
    if (!d) return "—";
    var dt = new Date(d);
    if (isNaN(dt)) return d;
    return dt.toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) + " UTC";
  }
  function statusPill(status) {
    var map = {
      active: ["ok", "Active"], draft: ["muted", "Draft"], discontinued: ["warn", "Discontinued"],
      obsolete: ["critical", "Obsolete"], pending_approval: ["warn", "Pending Approval"],
      revoked: ["critical", "Revoked"], approved: ["ok", "Approved"], in_review: ["warn", "In Review"],
    };
    var m = map[status] || ["muted", status];
    return '<span class="pill pill-' + m[0] + '">' + esc(m[1]) + "</span>";
  }
  function initials(name) {
    if (!name) return "??";
    return String(name).split(/\s+/).map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase();
  }
  function loadingBlock() { return '<div class="loading-block">Loading…</div>'; }
  function errorBlock(msg) { return '<div class="error-block">Could not load data: ' + esc(msg) + "</div>"; }

  async function api(path) {
    var res = await fetch(path);
    if (!res.ok) {
      var body = await res.json().catch(function () { return {}; });
      throw new Error(body.error || (res.status + " " + res.statusText));
    }
    return res.json();
  }
  async function apiPost(path, payload) {
    var res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      var body = await res.json().catch(function () { return {}; });
      throw new Error(body.error || (res.status + " " + res.statusText));
    }
    return res.json();
  }

  function pager(pageInfo, onPage) {
    if (!pageInfo || pageInfo.totalPages <= 1) return "";
    var p = pageInfo.page, tp = pageInfo.totalPages;
    return '<div class="pager">' +
      '<button class="pager-btn" data-page="' + (p - 1) + '" ' + (p <= 1 ? "disabled" : "") + '>← Prev</button>' +
      '<span class="pager-status">Page ' + p + " of " + tp + " · " + pageInfo.total.toLocaleString() + " total</span>" +
      '<button class="pager-btn" data-page="' + (p + 1) + '" ' + (p >= tp ? "disabled" : "") + ">Next →</button>" +
      "</div>";
  }

  function wirePager(container, onPage) {
    container.querySelectorAll(".pager-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        if (btn.hasAttribute("disabled")) return;
        onPage(Number(btn.dataset.page));
      });
    });
  }

  // ---------- router ----------
  function currentRoute() {
    var hash = location.hash.replace(/^#\/?/, "");
    var parts = hash.split("/").filter(Boolean);
    return parts.length ? parts : ["dashboard"];
  }

  function navigate() {
    var parts = currentRoute();
    var root = parts[0];
    document.querySelectorAll(".sidenav a").forEach(function (a) {
      a.classList.toggle("active", a.dataset.route === root);
    });
    if (root === "products" && parts[1]) {
      var newId = Number(parts[1]);
      if (state.selectedProductId !== newId) state.tabPage = {};
      state.selectedProductId = newId;
      state.selectedTab = parts[2] || "overview";
      renderProductDetail();
    } else if (root === "products") {
      renderProductList();
    } else if (root === "setup") {
      state.setupTab = parts[1] || "category";
      renderSetup();
    } else {
      renderDashboard();
    }
  }

  function goto(hash) { location.hash = hash; }

  // ---------- Dashboard ----------
  async function renderDashboard() {
    var main = el("#view");
    main.innerHTML = '<div class="page-head"><h1>Dashboard</h1><p class="page-sub">Product Management module overview — live data from PostgreSQL.</p></div>' + loadingBlock();
    try {
      var s = await api("/api/dashboard/summary");
      var maxCount = Math.max.apply(null, s.byCategory.map(function (x) { return x.count; }).concat([1]));

      main.innerHTML =
        '<div class="page-head"><h1>Dashboard</h1><p class="page-sub">Product Management module overview — live data from PostgreSQL.</p></div>' +
        '<div class="kpi-row">' +
          kpiTile("Products", s.totals.products.toLocaleString(), "in the live catalog") +
          kpiTile("Variants (SKUs)", s.totals.variants.toLocaleString(), "across all products") +
          kpiTile("Active Products", s.totals.active.toLocaleString(), Math.round((s.totals.active / s.totals.products) * 100) + "% of catalog") +
          kpiTile("Sterile-Packed", s.totals.sterile.toLocaleString(), "distinct sterile product records") +
        "</div>" +
        '<div class="dash-grid">' +
          '<section class="panel">' +
            '<h2 class="panel-title">Catalog by Category</h2>' +
            '<div class="bars">' +
              s.byCategory.map(function (x) {
                var pct = maxCount ? Math.round((x.count / maxCount) * 100) : 0;
                return '<div class="bar-row"><div class="bar-label">' + esc(x.name) + '</div>' +
                       '<div class="bar-track"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
                       '<div class="bar-value">' + x.count + "</div></div>";
              }).join("") +
            "</div>" +
          "</section>" +
          '<section class="panel">' +
            '<h2 class="panel-title">Certifications Expiring ≤ 120 Days</h2>' +
            (s.expiringCertifications.length
              ? '<ul class="expiry-list">' +
                s.expiringCertifications.map(function (x) {
                  var d = Number(x.daysLeft);
                  var urgency = d <= 30 ? "critical" : d <= 60 ? "warn" : "ok";
                  return '<li><a href="#/products/' + x.productId + '/certificates">' +
                         '<span class="pill pill-' + urgency + '">' + d + "d</span>" +
                         '<span class="expiry-name">' + esc(x.productName) + "</span>" +
                         '<span class="expiry-meta">' + esc(x.certName) + " · expires " + fmtDate(x.expiryDate) + "</span>" +
                         "</a></li>";
                }).join("") + "</ul>"
              : '<p class="empty-note">Nothing expiring in this window.</p>') +
          "</section>" +
        "</div>" +
        '<section class="panel">' +
          '<h2 class="panel-title">Recent Activity <span class="panel-subtitle">(from the audit trail)</span></h2>' +
          (s.recentActivity.length
            ? '<ul class="activity-list">' +
              s.recentActivity.map(function (a) {
                return '<li><span class="avatar">' + initials(a.productCode) + "</span>" +
                       '<div class="activity-body"><div>' + esc(a.action) + " on <a href=\"#/products/" + a.productId + "\">" + esc(a.productName) + "</a></div>" +
                       '<div class="activity-meta">' + fmtDateTime(a.changedAt) + "</div></div></li>";
              }).join("") + "</ul>"
            : '<p class="empty-note">No activity recorded yet.</p>') +
        "</section>";
    } catch (e) {
      main.innerHTML += errorBlock(e.message);
    }
  }

  function kpiTile(label, value, sub) {
    return '<div class="kpi"><div class="kpi-label">' + esc(label) + '</div>' +
           '<div class="kpi-value">' + esc(value) + '</div>' +
           '<div class="kpi-sub">' + esc(sub) + "</div></div>";
  }

  // ---------- Product List ----------
  async function loadCategories() {
    if (!state.cache.categories) state.cache.categories = await api("/api/setup/categories");
    return state.cache.categories;
  }
  async function loadFamilies(categoryId) {
    if (!state.cache.families[categoryId]) state.cache.families[categoryId] = await api("/api/setup/families?categoryId=" + categoryId);
    return state.cache.families[categoryId];
  }
  async function loadTypes(familyId) {
    if (!state.cache.types[familyId]) state.cache.types[familyId] = await api("/api/setup/types?familyId=" + familyId);
    return state.cache.types[familyId];
  }
  async function loadMaterials() {
    if (!state.cache.materials) state.cache.materials = await api("/api/setup/materials");
    return state.cache.materials;
  }

  async function renderProductList() {
    var main = el("#view");
    main.innerHTML = '<div class="page-head"><h1>Products</h1><p class="page-sub">Loading catalog…</p></div>' + loadingBlock();

    var f = state.productFilters;
    var categories, materials, families = [], types = [];
    try {
      categories = await loadCategories();
      materials = await loadMaterials();
      if (f.categoryId) families = await loadFamilies(f.categoryId);
      if (f.familyId) types = await loadTypes(f.familyId);
    } catch (e) {
      main.innerHTML = errorBlock(e.message);
      return;
    }

    var params = new URLSearchParams();
    if (f.categoryId) params.set("category", f.categoryId);
    if (f.familyId) params.set("family", f.familyId);
    if (f.typeId) params.set("type", f.typeId);
    if (f.status) params.set("status", f.status);
    if (f.material) params.set("material", f.material);
    if (f.q) params.set("q", f.q);
    params.set("page", state.productPage);
    params.set("pageSize", 25);

    var result;
    try {
      result = await api("/api/products?" + params.toString());
    } catch (e) {
      main.innerHTML = errorBlock(e.message);
      return;
    }

    var treeHtml = '<button class="tree-node ' + (!f.categoryId ? "active" : "") + '" data-cat="">All Categories</button>' +
      categories.map(function (cat) {
        var isActiveCat = f.categoryId === cat.id;
        var html = '<button class="tree-node ' + (isActiveCat ? "active" : "") + '" data-cat="' + cat.id + '">' + esc(cat.name) + "</button>";
        if (isActiveCat) {
          html += families.map(function (fam) {
            var isActiveFam = f.familyId === fam.id;
            var h = '<button class="tree-node tree-sub ' + (isActiveFam ? "active" : "") + '" data-fam="' + fam.id + '">' + esc(fam.name) + "</button>";
            if (isActiveFam) {
              h += types.map(function (t) {
                return '<button class="tree-node tree-sub2 ' + (f.typeId === t.id ? "active" : "") + '" data-typ="' + t.id + '">' + esc(t.name) + "</button>";
              }).join("");
            }
            return h;
          }).join("");
        }
        return html;
      }).join("");

    main.innerHTML =
      '<div class="page-head"><h1>Products</h1><p class="page-sub">' + result.total.toLocaleString() + " products in the live catalog.</p></div>" +
      '<div class="list-layout">' +
        '<aside class="filter-rail">' +
          '<div class="filter-block"><div class="filter-label">Hierarchy</div><div class="tree" id="cat-tree">' + treeHtml + "</div></div>" +
          '<div class="filter-block"><div class="filter-label">Status</div>' +
            '<select id="f-status"><option value="">All</option><option value="active">Active</option><option value="discontinued">Discontinued</option></select></div>' +
          '<div class="filter-block"><div class="filter-label">Material</div>' +
            '<select id="f-material"><option value="">All</option>' +
            materials.map(function (m) { return '<option value="' + m.id + '">' + esc(m.name) + "</option>"; }).join("") +
            "</select></div>" +
        "</aside>" +
        '<div class="list-main">' +
          '<div class="search-row"><input id="f-search" type="search" placeholder="Search by product name or code…" value="' + esc(f.q) + '" /></div>' +
          '<div class="table-wrap"><table class="data-table"><thead><tr>' +
            "<th>Product Code</th><th>Name</th><th>Category</th><th>Material</th><th>SKUs</th><th>Status</th><th>Sterile</th>" +
          "</tr></thead><tbody id=\"prod-rows\">" + result.data.map(productRow).join("") + "</tbody></table></div>" +
          pager(result, null) +
        "</div>" +
      "</div>";

    el("#f-status").value = f.status;
    el("#f-status").addEventListener("change", function (e) { state.productFilters.status = e.target.value; state.productPage = 1; renderProductList(); });
    el("#f-material").value = f.material;
    el("#f-material").addEventListener("change", function (e) { state.productFilters.material = e.target.value; state.productPage = 1; renderProductList(); });

    var searchInput = el("#f-search");
    var searchTimer = null;
    searchInput.addEventListener("input", function (e) {
      clearTimeout(searchTimer);
      var val = e.target.value;
      searchTimer = setTimeout(function () {
        state.productFilters.q = val; state.productPage = 1; renderProductList();
      }, 350);
    });
    searchInput.focus();
    searchInput.setSelectionRange(f.q.length, f.q.length);

    el("#cat-tree").addEventListener("click", function (e) {
      var btn = e.target.closest(".tree-node");
      if (!btn) return;
      if (btn.dataset.cat !== undefined) {
        state.productFilters.categoryId = btn.dataset.cat ? Number(btn.dataset.cat) : null;
        state.productFilters.familyId = null; state.productFilters.typeId = null;
      } else if (btn.dataset.fam !== undefined) {
        var famId = Number(btn.dataset.fam);
        state.productFilters.familyId = state.productFilters.familyId === famId ? null : famId;
        state.productFilters.typeId = null;
      } else if (btn.dataset.typ !== undefined) {
        var typId = Number(btn.dataset.typ);
        state.productFilters.typeId = state.productFilters.typeId === typId ? null : typId;
      }
      state.productPage = 1;
      renderProductList();
    });

    el("#prod-rows").addEventListener("click", function (e) {
      var row = e.target.closest("tr[data-id]");
      if (row) goto("#/products/" + row.dataset.id);
    });

    wirePager(main, function (page) { state.productPage = page; renderProductList(); });
  }

  function productRow(p) {
    var mats = (p.materials || []).join(", ") || "—";
    return '<tr data-id="' + p.id + '" tabindex="0">' +
      "<td><code>" + esc(p.code) + "</code>" + (p.legacyCode && p.legacyCode !== p.code ? '<div class="cell-sub">was ' + esc(p.legacyCode) + "</div>" : "") + "</td>" +
      "<td>" + esc(p.name) + "</td>" +
      '<td><div class="cell-sub">' + esc(p.categoryName || "—") + "</div>" + esc(p.typeName || "—") + "</td>" +
      "<td>" + esc(mats) + "</td>" +
      "<td>" + p.variantCount + "</td>" +
      "<td>" + statusPill(p.status) + "</td>" +
      "<td>" + (p.isSterile ? '<span class="pill pill-accent">Sterile</span>' : "—") + "</td>" +
      "</tr>";
  }

  // ---------- Product Detail ----------
  var TABS = [
    ["overview", "Overview"], ["variants", "Variants"], ["documents", "Documents"],
    ["images", "Images"], ["pricing", "Pricing"], ["revisions", "Revision History"],
    ["certificates", "Certificates"], ["audit", "Audit Log"], ["attachments", "Attachments"],
  ];

  async function renderProductDetail() {
    var main = el("#view");
    main.innerHTML = loadingBlock();
    var p;
    try {
      p = await api("/api/products/" + state.selectedProductId);
    } catch (e) {
      main.innerHTML = '<p class="crumb"><a href="#/products">← Back to Products</a></p>' + errorBlock(e.message);
      return;
    }

    main.innerHTML =
      '<div class="crumb"><a href="#/products">Products</a> / ' + esc(p.categoryName) + " / " + esc(p.typeName) + "</div>" +
      '<div class="detail-head">' +
        '<div><h1>' + esc(p.name) + "</h1>" +
        '<div class="detail-sub"><code>' + esc(p.code) + "</code>" +
          (p.legacyCode && p.legacyCode !== p.code ? '<span class="was-code">legacy code: ' + esc(p.legacyCode) + "</span>" : "") +
          statusPill(p.status) +
          (p.isSterile ? '<span class="pill pill-accent">Sterile</span>' : "") +
          (p.catalogVisible ? '<span class="pill pill-ok-outline">Catalog visible</span>' : '<span class="pill pill-muted-outline">Hidden from catalog</span>') +
        "</div></div>" +
      "</div>" +
      '<div class="tab-bar">' +
        TABS.map(function (t) {
          return '<button class="tab-btn ' + (state.selectedTab === t[0] ? "active" : "") + '" data-tab="' + t[0] + '">' + t[1] + "</button>";
        }).join("") +
      "</div>" +
      '<div class="tab-panel" id="tab-panel">' + loadingBlock() + "</div>";

    el(".tab-bar").addEventListener("click", function (e) {
      var btn = e.target.closest(".tab-btn");
      if (!btn) return;
      goto("#/products/" + p.id + "/" + btn.dataset.tab);
    });

    renderTabPanel(p);
  }

  async function renderTabPanel(p) {
    var panel = el("#tab-panel");
    var fn = {
      overview: tabOverview, variants: tabVariants, documents: tabDocuments,
      images: tabImages, pricing: tabPricing, revisions: tabRevisions,
      certificates: tabCertificates, audit: tabAudit, attachments: tabAttachments,
    }[state.selectedTab] || tabOverview;
    try {
      panel.innerHTML = await fn(p);
    } catch (e) {
      panel.innerHTML = errorBlock(e.message);
    }
    var pageInfo = state.tabPage[state.selectedTab];
    if (pageInfo) {
      wirePager(panel, function (page) {
        state.tabPage[state.selectedTab] = Object.assign({}, pageInfo, { page: page });
        renderTabPanel(p);
      });
    }
  }

  function dl(pairs) {
    return '<dl class="kv">' + pairs.map(function (kv) {
      return "<dt>" + esc(kv[0]) + "</dt><dd>" + kv[1] + "</dd>";
    }).join("") + "</dl>";
  }

  async function tabOverview(p) {
    return '<div class="overview-grid">' +
      '<div class="panel"><h2 class="panel-title">Classification</h2>' +
        dl([["Category", esc(p.categoryName)], ["Family", esc(p.familyName)], ["Type", esc(p.typeName)],
            ["Product Code", "<code>" + esc(p.code) + "</code>" + (p.legacyCode && p.legacyCode !== p.code ? " <span class=\"cell-sub\">(legacy: " + esc(p.legacyCode) + ")</span>" : "")]]) +
      "</div>" +
      '<div class="panel"><h2 class="panel-title">Lifecycle</h2>' +
        dl([["Status", statusPill(p.status)], ["Catalog Visible", p.catalogVisible ? "Yes" : "No"],
            ["Sterile Packaging", p.isSterile ? "Yes" : "No"], ["Current Revision", p.currentRevisionCode ? esc(p.currentRevisionCode) : '<span class="empty-note">None recorded</span>'],
            ["Created", fmtDateTime(p.createdAt)], ["Last Updated", fmtDateTime(p.updatedAt)]]) +
      "</div>" +
      '<div class="panel span-2"><h2 class="panel-title">Notes</h2>' +
        '<p class="body-text">' + (p.remark ? esc(p.remark) : '<span class="empty-note">No remarks recorded.</span>') + "</p>" +
      "</div>" +
    "</div>";
  }

  async function tabVariants(p) {
    var pageInfo = state.tabPage.variants || { page: 1 };
    var result = await api("/api/products/" + p.id + "/variants?page=" + pageInfo.page + "&pageSize=15");
    state.tabPage.variants = result;
    return '<div class="table-wrap"><table class="data-table"><thead><tr>' +
      "<th>Variant Code</th><th>Material</th><th>Dimensions</th><th>UDI-DI</th><th>Price (list, INR)</th><th>Status</th>" +
      "</tr></thead><tbody>" +
      result.data.map(function (v) {
        return "<tr><td><code>" + esc(v.code) + "</code></td>" +
          "<td>" + (v.materialName ? esc(v.materialName) : '<span class="empty-note">Not specified</span>') + "</td>" +
          "<td>" + esc(v.sizeText) + "</td>" +
          "<td><code>" + esc(v.udi) + "</code></td>" +
          "<td>" + fmtMoney(v.priceInr, "INR") + "</td>" +
          "<td>" + statusPill(v.status) + (v.hasCertOverride ? ' <span class="pill pill-critical" title="This SKU has a certification override">Cert override</span>' : "") + "</td>" +
          "</tr>";
      }).join("") +
      "</tbody></table></div>" + pager(result);
  }

  async function tabDocuments(p) {
    var rows = await api("/api/products/" + p.id + "/documents");
    if (!rows.length) return emptyState("No controlled documents linked to this product yet.");
    return '<div class="table-wrap"><table class="data-table"><thead><tr><th>Type</th><th>Title</th><th>Revision</th><th>Status</th><th>Effective</th></tr></thead><tbody>' +
      rows.map(function (d) {
        return "<tr><td>" + esc(d.typeName) + "</td><td>" + esc(d.title) + "</td><td><code>" + esc(d.revisionNo) + "</code></td>" +
          "<td>" + statusPill(d.status) + "</td><td>" + fmtDate(d.effectiveDate) + "</td></tr>";
      }).join("") + "</tbody></table></div>";
  }

  async function tabImages(p) {
    var rows = await api("/api/products/" + p.id + "/images");
    if (!rows.length) return emptyState("No images uploaded for " + esc(p.code) + " yet.");
    return '<div class="image-grid">' +
      rows.map(function (img) {
        return '<figure class="image-tile"><div class="image-placeholder" data-kind="' + esc(img.imageType) + '"><span>' + esc(p.code) + "</span></div>" +
          "<figcaption>" + esc(img.imageType) + " · <code>" + esc(img.storageKey) + "</code></figcaption></figure>";
      }).join("") + "</div>";
  }

  async function tabPricing(p) {
    var pageInfo = state.tabPage.pricing || { page: 1 };
    var result = await api("/api/products/" + p.id + "/pricing?page=" + pageInfo.page + "&pageSize=15");
    state.tabPage.pricing = result;
    if (!result.data.length) return emptyState("No pricing recorded for this product's SKUs.");
    return '<div class="table-wrap"><table class="data-table"><thead><tr><th>Variant</th><th>Price Type</th><th>Currency</th><th>Amount</th><th>Valid From</th><th>Current</th></tr></thead><tbody>' +
      result.data.map(function (r) {
        return "<tr><td><code>" + esc(r.variantCode) + "</code></td><td>" + esc(r.priceType.replace("_", " ")) + "</td><td>" + esc(r.currency) + "</td>" +
          "<td>" + fmtMoney(r.amount, r.currency) + "</td><td>" + fmtDate(r.validFrom) + "</td>" +
          "<td>" + (r.isCurrent ? '<span class="pill pill-ok">Current</span>' : "—") + "</td></tr>";
      }).join("") + "</tbody></table></div>" + pager(result);
  }

  async function tabRevisions(p) {
    var rows = await api("/api/products/" + p.id + "/revisions");
    if (!rows.length) return emptyState("No revision history recorded for this product yet (V1 did not track ECNs).");
    return '<ol class="timeline">' +
      rows.map(function (r) {
        return '<li class="timeline-item ' + (r.isCurrent ? "current" : "") + '">' +
          '<div class="timeline-dot"></div>' +
          '<div class="timeline-body">' +
            '<div class="timeline-head"><span class="rev-code">Rev. ' + esc(r.code) + "</span>" + statusPill(r.status) + (r.isCurrent ? '<span class="pill pill-accent">Current</span>' : "") + "</div>" +
            "<p class=\"body-text\">" + esc(r.changeDescription) + "</p>" +
            '<dl class="kv kv-inline">' +
              (r.ecnNumber ? "<dt>ECN</dt><dd><code>" + esc(r.ecnNumber) + "</code></dd>" : "") +
              "<dt>Reason</dt><dd>" + esc(r.reasonForChange || "—") + "</dd>" +
              "<dt>Requested by</dt><dd>" + esc(r.requestedBy || "—") + "</dd>" +
              "<dt>Approved by</dt><dd>" + esc(r.approvedBy || "—") + "</dd>" +
              "<dt>Effective</dt><dd>" + fmtDate(r.effectiveDate) + "</dd>" +
            "</dl>" +
          "</div></li>";
      }).join("") + "</ol>";
  }

  async function tabCertificates(p) {
    var data = await api("/api/products/" + p.id + "/certificates");
    if (!data.productLevel.length) return emptyState("No active certifications recorded for this product.");
    var html = '<div class="table-wrap"><table class="data-table"><thead><tr><th>Regulator</th><th>Certificate No.</th><th>Issued</th><th>Expires</th><th>Status</th></tr></thead><tbody>' +
      data.productLevel.map(function (c) {
        var d = c.daysLeft == null ? null : Number(c.daysLeft);
        var urgent = d != null && d <= 120 ? ' <span class="pill pill-' + (d <= 30 ? "critical" : d <= 60 ? "warn" : "ok") + '">' + d + "d left</span>" : "";
        return "<tr><td>" + esc(c.certName) + "</td><td><code>" + esc(c.certificateNumber || "—") + "</code></td>" +
          "<td>" + fmtDate(c.issueDate) + "</td><td>" + fmtDate(c.expiryDate) + urgent + "</td><td>" + statusPill(c.status) + "</td></tr>";
      }).join("") + "</tbody></table></div>";

    if (data.variantOverrides.length) {
      html += '<h3 class="sub-heading">SKU-Level Overrides</h3>' +
        '<p class="body-text">' + data.variantOverrides.length + " of this product's SKUs are certified differently from the product-level record above:</p>" +
        '<div class="table-wrap"><table class="data-table"><thead><tr><th>Variant</th><th>Regulator</th><th>Override Status</th></tr></thead><tbody>' +
        data.variantOverrides.map(function (v) {
          return "<tr><td><code>" + esc(v.variantCode) + "</code></td><td>" + esc(v.certName) + "</td><td>" + statusPill(v.status) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
    return html;
  }

  async function tabAudit(p) {
    var pageInfo = state.tabPage.audit || { page: 1 };
    var result = await api("/api/products/" + p.id + "/audit?page=" + pageInfo.page + "&pageSize=15");
    state.tabPage.audit = result;
    if (!result.data.length) return emptyState("No audit history recorded yet.");
    return '<ul class="audit-list">' +
      result.data.map(function (a) {
        var verb = a.action === "INSERT" ? "created a " + esc(a.tableName) + " record" :
          a.action === "DELETE" ? "deleted a " + esc(a.tableName) + " record" :
          "updated a " + esc(a.tableName) + " record";
        return '<li><span class="avatar">' + initials(a.tableName) + "</span><div class=\"activity-body\">" +
          "<div>" + verb + " <span class=\"cell-sub\">(id " + esc(a.recordPk) + ")</span></div>" +
          '<div class="activity-meta"><span class="pill pill-muted-outline">' + esc(a.action) + "</span> " + fmtDateTime(a.changedAt) + "</div></div></li>";
      }).join("") + "</ul>" + pager(result);
  }

  async function tabAttachments(p) {
    var rows = await api("/api/products/" + p.id + "/attachments");
    return '<p class="table-footnote">Uncategorized files linked to this product — distinct from the controlled Documents tab.</p>' +
      (rows.length ? "" : emptyState("No ad-hoc attachments uploaded for " + esc(p.code) + " yet."));
  }

  function emptyState(msg) { return '<div class="empty-block">' + esc(msg) + "</div>"; }

  // ---------- Catalog Setup (admin) ----------
  var SETUP_TABS = [
    ["category", "Categories"], ["family", "Families"], ["type", "Types"],
    ["material", "Materials"], ["certtype", "Certification Types"],
  ];

  async function renderSetup() {
    var main = el("#view");
    main.innerHTML =
      '<div class="page-head"><h1>Catalog Setup</h1><p class="page-sub">Manage the master &amp; lookup tables behind the product hierarchy — writes go straight to PostgreSQL.</p></div>' +
      '<div class="tab-bar">' +
        SETUP_TABS.map(function (t) {
          return '<button class="tab-btn ' + (state.setupTab === t[0] ? "active" : "") + '" data-tab="' + t[0] + '">' + t[1] + "</button>";
        }).join("") +
      "</div>" +
      '<div class="tab-panel" id="setup-panel">' + loadingBlock() + "</div>";

    el(".tab-bar").addEventListener("click", function (e) {
      var btn = e.target.closest(".tab-btn");
      if (!btn) return;
      goto("#/setup/" + btn.dataset.tab);
    });

    renderSetupPanel();
  }

  var SETUP_CONFIG = {
    category: { endpoint: "/api/setup/categories", cols: [["code", "Code"], ["name", "Name"]], label: "Category", fields: [{ key: "name", label: "Name" }] },
    family: {
      endpoint: "/api/setup/families", cols: [["name", "Name"], ["categoryName", "Category"]], label: "Family",
      fields: [{ key: "name", label: "Name" }, { key: "categoryId", label: "Category", type: "select-category" }],
    },
    type: {
      endpoint: "/api/setup/types", cols: [["name", "Name"], ["familyName", "Family"]], label: "Type",
      fields: [{ key: "name", label: "Name" }, { key: "familyId", label: "Family", type: "select-family" }],
    },
    material: { endpoint: "/api/setup/materials", cols: [["code", "Code"], ["name", "Name"], ["standard", "Standard"]], label: "Material", fields: [{ key: "name", label: "Name" }, { key: "standard", label: "Standard" }] },
    certtype: { endpoint: "/api/setup/cert-types", cols: [["code", "Code"], ["name", "Name"]], label: "Certification Type", fields: [{ key: "name", label: "Name" }] },
  };

  async function renderSetupPanel() {
    var panel = el("#setup-panel");
    var cfg = SETUP_CONFIG[state.setupTab];
    var list;
    try {
      list = await api(cfg.endpoint);
    } catch (e) {
      panel.innerHTML = errorBlock(e.message);
      return;
    }

    panel.innerHTML =
      '<div class="setup-toolbar"><button class="btn-primary" id="add-row">+ Add ' + cfg.label + "</button></div>" +
      '<div class="table-wrap"><table class="data-table"><thead><tr>' +
        cfg.cols.map(function (c) { return "<th>" + c[1] + "</th>"; }).join("") +
      "</tr></thead><tbody>" +
      list.map(function (row) { return setupRow(row, cfg); }).join("") +
      "</tbody></table></div>";

    el("#add-row").addEventListener("click", async function () {
      var payload = {};
      for (var f of cfg.fields) {
        if (f.type === "select-category") {
          var cats = await loadCategories();
          var choice = prompt("Category for this " + cfg.label + ":\n" + cats.map(function (c, i) { return (i + 1) + ". " + c.name; }).join("\n"));
          var idx = parseInt(choice, 10) - 1;
          if (!cats[idx]) return;
          payload.categoryId = cats[idx].id;
        } else if (f.type === "select-family") {
          var cats2 = await loadCategories();
          var allFamilies = [];
          for (var c of cats2) allFamilies = allFamilies.concat(await loadFamilies(c.id));
          var choice2 = prompt("Family for this " + cfg.label + ":\n" + allFamilies.map(function (fam, i) { return (i + 1) + ". " + fam.name; }).join("\n"));
          var idx2 = parseInt(choice2, 10) - 1;
          if (!allFamilies[idx2]) return;
          payload.familyId = allFamilies[idx2].id;
        } else {
          var val = prompt(f.label + " for the new " + cfg.label + ":");
          if (f.key === "name" && !val) return;
          payload[f.key] = val || null;
        }
      }
      try {
        await apiPost(cfg.endpoint, payload);
        state.cache = { categories: null, materials: null, certTypes: null, families: {}, types: {} };
        renderSetupPanel();
      } catch (e) {
        alert("Could not save: " + e.message);
      }
    });
  }

  function setupRow(row, cfg) {
    return "<tr>" + cfg.cols.map(function (c) {
      var val = row[c[0]];
      return "<td>" + (c[0] === "code" ? "<code>" + esc(val) + "</code>" : esc(val == null ? "—" : val)) + "</td>";
    }).join("") + "</tr>";
  }

  // ---------- theme toggle ----------
  function initTheme() {
    var btn = el("#theme-toggle");
    var root = document.documentElement;
    btn.addEventListener("click", function () {
      var cur = root.getAttribute("data-theme");
      var sysDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      var next = cur === "dark" ? "light" : cur === "light" ? (sysDark ? "dark" : "light") : (sysDark ? "light" : "dark");
      root.setAttribute("data-theme", next);
      btn.textContent = next === "dark" ? "☀︎ Light" : "☽︎ Dark";
    });
  }

  function initGlobalSearch() {
    var box = el("#global-search");
    box.addEventListener("keydown", function (e) {
      if (e.key === "Enter" && box.value.trim()) {
        state.productFilters.q = box.value.trim();
        state.productFilters.categoryId = null; state.productFilters.familyId = null; state.productFilters.typeId = null;
        state.productPage = 1;
        goto("#/products");
      }
    });
  }

  window.addEventListener("hashchange", navigate);
  document.addEventListener("DOMContentLoaded", function () {
    initTheme();
    initGlobalSearch();
    navigate();
  });
})();
