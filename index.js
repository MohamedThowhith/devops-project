const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──
app.use(cors());
app.use(express.json());

// ── DB Setup ──
const db = new Database(path.join(__dirname, "expenses.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT    NOT NULL UNIQUE,
    color TEXT    NOT NULL DEFAULT '#6366f1'
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT    NOT NULL,
    amount     REAL    NOT NULL CHECK(amount > 0),
    category   TEXT    NOT NULL DEFAULT 'General',
    note       TEXT,
    created_at DATETIME DEFAULT (datetime('now'))
  );
`);

// Seed default categories if empty
const catCount = db.prepare("SELECT COUNT(*) AS c FROM categories").get().c;
if (catCount === 0) {
  const insert = db.prepare("INSERT OR IGNORE INTO categories (name, color) VALUES (?, ?)");
  [
    ["Food",        "#f59e0b"],
    ["Transport",   "#3b82f6"],
    ["Health",      "#10b981"],
    ["Shopping",    "#ec4899"],
    ["Bills",       "#f97316"],
    ["Entertainment","#8b5cf6"],
    ["General",     "#6366f1"],
  ].forEach(([n, c]) => insert.run(n, c));
}

// ── Helpers ──
function fmt(n) { return Number(n || 0); }

// ── SUMMARY ──
app.get("/summary", (req, res) => {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(amount), 0)   AS total,
      COUNT(*)                    AS count,
      COALESCE(AVG(amount), 0)   AS average,
      COALESCE(MAX(amount), 0)   AS max,
      COALESCE(MIN(amount), 0)   AS min
    FROM expenses
  `).get();
  res.json({
    total:   fmt(row.total),
    count:   row.count,
    average: fmt(row.average),
    max:     fmt(row.max),
    min:     fmt(row.min),
  });
});

// ── CATEGORIES ──
app.get("/categories", (req, res) => {
  const rows = db.prepare("SELECT * FROM categories ORDER BY name").all();
  res.json(rows);
});

app.post("/categories", (req, res) => {
  const { name, color } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: "Category name is required" });
  try {
    const info = db.prepare("INSERT INTO categories (name, color) VALUES (?, ?)").run(name.trim(), color || "#6366f1");
    res.status(201).json({ id: info.lastInsertRowid, name: name.trim(), color: color || "#6366f1" });
  } catch (e) {
    if (e.message.includes("UNIQUE")) return res.status(400).json({ error: "Category already exists" });
    res.status(500).json({ error: "Server error" });
  }
});

app.delete("/categories/:id", (req, res) => {
  const { id } = req.params;
  const cat = db.prepare("SELECT * FROM categories WHERE id = ?").get(id);
  if (!cat) return res.status(404).json({ error: "Category not found" });
  const inUse = db.prepare("SELECT COUNT(*) AS c FROM expenses WHERE category = ?").get(cat.name).c;
  if (inUse > 0) return res.status(400).json({ error: `Category is used by ${inUse} expense(s)` });
  db.prepare("DELETE FROM categories WHERE id = ?").run(id);
  res.json({ message: "Category deleted" });
});

// ── EXPENSES ──

// GET /expenses — paginated, searchable, sortable, filterable
app.get("/expenses", (req, res) => {
  const page     = Math.max(1, parseInt(req.query.page)  || 1);
  const limit    = Math.min(100, parseInt(req.query.limit) || 15);
  const offset   = (page - 1) * limit;
  const search   = req.query.search   || "";
  const category = req.query.category || "";
  const sort     = ["id", "amount", "title", "created_at"].includes(req.query.sort) ? req.query.sort : "id";
  const order    = req.query.order === "ASC" ? "ASC" : "DESC";

  const conditions = [];
  const params = [];

  if (search) {
    conditions.push("(title LIKE ? OR note LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

  const total = db.prepare(`SELECT COUNT(*) AS c FROM expenses ${where}`).get(...params).c;
  const data  = db.prepare(`SELECT * FROM expenses ${where} ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`).all(...params, limit, offset);

  res.json({
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// GET /expenses/:id — single expense
app.get("/expenses/:id", (req, res) => {
  const exp = db.prepare("SELECT * FROM expenses WHERE id = ?").get(req.params.id);
  if (!exp) return res.status(404).json({ error: "Expense not found" });
  res.json(exp);
});

// POST /add-expense
app.post("/add-expense", (req, res) => {
  const { title, amount, category, note } = req.body;
  const errors = [];
  if (!title?.trim())         errors.push("Title is required");
  if (!amount || amount <= 0) errors.push("Amount must be greater than 0");
  if (errors.length) return res.status(400).json({ errors });

  const info = db.prepare(
    "INSERT INTO expenses (title, amount, category, note) VALUES (?, ?, ?, ?)"
  ).run(title.trim(), parseFloat(amount), category || "General", note?.trim() || null);

  const exp = db.prepare("SELECT * FROM expenses WHERE id = ?").get(info.lastInsertRowid);
  res.status(201).json(exp);
});

// PUT /update-expense/:id
app.put("/update-expense/:id", (req, res) => {
  const { id } = req.params;
  const exp = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
  if (!exp) return res.status(404).json({ error: "Expense not found" });

  const { title, amount, category, note } = req.body;
  const errors = [];
  if (!title?.trim())         errors.push("Title is required");
  if (!amount || amount <= 0) errors.push("Amount must be greater than 0");
  if (errors.length) return res.status(400).json({ errors });

  db.prepare(
    "UPDATE expenses SET title = ?, amount = ?, category = ?, note = ? WHERE id = ?"
  ).run(title.trim(), parseFloat(amount), category || exp.category, note?.trim() || null, id);

  res.json(db.prepare("SELECT * FROM expenses WHERE id = ?").get(id));
});

// DELETE /delete-expense/:id
app.delete("/delete-expense/:id", (req, res) => {
  const info = db.prepare("DELETE FROM expenses WHERE id = ?").run(req.params.id);
  if (!info.changes) return res.status(404).json({ error: "Expense not found" });
  res.json({ message: "Expense deleted" });
});

// DELETE /delete-expenses  (bulk)
app.delete("/delete-expenses", (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: "No IDs provided" });
  const placeholders = ids.map(() => "?").join(",");
  const info = db.prepare(`DELETE FROM expenses WHERE id IN (${placeholders})`).run(...ids);
  res.json({ message: `${info.changes} expense(s) deleted`, deleted: info.changes });
});

// ── DATE FILTER ──
app.get("/expenses-by-date", (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return res.status(400).json({ error: "start and end dates required" });
  const data = db.prepare(
    "SELECT * FROM expenses WHERE DATE(created_at) BETWEEN ? AND ? ORDER BY created_at DESC"
  ).all(start, end);
  res.json(data);
});

// ── CHART DATA ──

// GET /chart-data?range=30  — daily totals
app.get("/chart-data", (req, res) => {
  const range = Math.min(365, parseInt(req.query.range) || 30);
  const data = db.prepare(`
    SELECT DATE(created_at) AS date, SUM(amount) AS total
    FROM expenses
    WHERE created_at >= DATE('now', ? || ' days')
    GROUP BY DATE(created_at)
    ORDER BY date ASC
  `).all(`-${range}`);
  res.json(data);
});

// GET /chart-data/monthly
app.get("/chart-data/monthly", (req, res) => {
  const data = db.prepare(`
    SELECT strftime('%Y-%m', created_at) AS month, SUM(amount) AS total
    FROM expenses
    GROUP BY month
    ORDER BY month ASC
    LIMIT 24
  `).all();
  res.json(data);
});

// GET /chart-data/category
app.get("/chart-data/category", (req, res) => {
  const data = db.prepare(`
    SELECT category, SUM(amount) AS total
    FROM expenses
    GROUP BY category
    ORDER BY total DESC
  `).all();
  res.json(data);
});

// ── EXPORT CSV ──
app.get("/export/csv", (req, res) => {
  const rows = db.prepare("SELECT * FROM expenses ORDER BY created_at DESC").all();
  const headers = ["id", "title", "amount", "category", "note", "created_at"];
  const escape  = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const csv = [
    headers.join(","),
    ...rows.map(r => headers.map(h => escape(r[h])).join(",")),
  ].join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="expenses-${Date.now()}.csv"`);
  res.send(csv);
});

// ── Start ──
app.listen(PORT, () => console.log(`✅ Xpense Tracker API running on http://localhost:${PORT}`));