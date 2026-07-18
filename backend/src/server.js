require("dotenv").config();
const path = require("path");
const express = require("express");

const lookupsRouter = require("./routes/lookups");
const dashboardRouter = require("./routes/dashboard");
const productsRouter = require("./routes/products");

const app = express();
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ status: "ok" }));
app.use("/api/setup", lookupsRouter);
app.use("/api/dashboard", dashboardRouter);
app.use("/api/products", productsRouter);

app.use(express.static(path.join(__dirname, "..", "public")));
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Internal server error", detail: err.message });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`OrthoERP Product Management API listening on port ${PORT}`);
});
