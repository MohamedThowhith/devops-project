const express = require("express");
const cors = require("cors");
const Database = require("better-sqlite3");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──
app.use(cors());
app.use(express.json());

// ── Database Setup ──
const db = new Database(path.join(__dirname, "expenses.db"));

db.exec(`
  PRAGMA journal_mode = WAL;

  CREATE TABLE IF NOT EXISTS categories (
    id    INTEGER PRIMARY KEY AUTOINCREMENT,
    name  TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '#6366f1'
  );

  CREATE TABLE IF NOT EXISTS expenses (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    title      TEXT NOT NULL,
    amount     REAL NOT NULL CHECK(amount > 0),
    category   TEXT NOT NULL DEFAULT 'General',
    note       TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Seed default categories if none exist
  INSERT OR IGNORE INTO categories (name, color) VALUES
    ('General',       '#6366f1'),
    ('Food',          '#f59e0b'),
    ('Transport',     '#10b981'),
    ('Shopping',      '#ec4899'),
    ('Entertainment', '#8b5cf6'),
    ('Health',        '#ef4444'),
    ('Bills',         '#3b82f6'),
    ('Education',     '#14b8a6');
`);

// ── Helper ──
function ok(res, data, status = 200) {
  return res.status(status).json(data);
}
function err(res, msg, status = 400) {
  return res.status(status).json({ error: msg });
}

// ══════════════════════════════════════════
//  CATEGORIES
// ══════════════════════════════════════════

// GET /categories
app.get("/categories", (req, res) => {
  const rows = db.prepare("SELECT * FROM categories ORDER BY name ASC").all();
  ok(res, rows);
});

// POST /categories
app.post("/categories", (req, res) => {
  const { name, color } = req.body;
  if (!name?.trim()) return err(res, "Category name is required");

  try {
    const stmt = db.prepare("INSERT INTO categories (name, color) VALUES (?, ?)");
    const result = stmt.run(name.trim(), color || "#6366f1");
    ok(res, { id: result.lastInsertRowid, name: name.trim(), color: color || "#6366f1" }, 201);
  } catch (e) {
    if (e.message.includes("UNIQUE")) return err(res, "Category already exists");
    err(res, "Failed to create category", 500);
  }
});

// DELETE /categories/:id
app.delete("/categories/:id", (req, res) => {
  const { id } = req.params;
  const cat = db.prepare("SELECT * FROM categories WHERE id = ?").get(id);
  if (!cat) return err(res, "Category not found", 404);

  db.prepare("DELETE FROM categories WHERE id = ?").run(id);
  ok(res, { message: "Category deleted" });
});

// ══════════════════════════════════════════
//  EXPENSES
// ══════════════════════════════════════════

// GET /expenses  — paginated, searchable, sortable, filterable by category
app.get("/expenses", (req, res) => {
  const page     = Math.max(1, parseInt(req.query.page)  || 1);
  const limit    = Math.min(100, parseInt(req.query.limit) || 15);
  const offset   = (page - 1) * limit;
  const search   = req.query.search   || "";
  const category = req.query.category || "";
  const sort     = ["id", "amount", "title"].includes(req.query.sort) ? req.query.sort : "id";
  const order    = req.query.order === "ASC" ? "ASC" : "DESC";

  const conditions = [];
  const params     = [];

  if (search) {
    conditions.push("(title LIKE ? OR note LIKE ?)");
    params.push(`%${search}%`, `%${search}%`);
  }
  if (category) {
    conditions.push("category = ?");
    params.push(category);
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

  const total = db.prepare(`SELECT COUNT(*) as n FROM expenses ${where}`).get(...params).n;
  const data  = db.prepare(
    `SELECT * FROM expenses ${where} ORDER BY ${sort} ${order} LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  ok(res, {
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// GET /expenses/:id
app.get("/expenses/:id", (req, res) => {
  const row = db.prepare("SELECT * FROM expenses WHERE id = ?").get(req.params.id);
  if (!row) return err(res, "Expense not found", 404);
  ok(res, row);
});

// POST /add-expense
app.post("/add-expense", (req, res) => {
  const { title, amount, category, note } = req.body;
  const errors = [];
  if (!title?.trim())             errors.push("Title is required");
  if (!amount || Number(amount) <= 0) errors.push("Amount must be greater than 0");
  if (errors.length) return res.status(400).json({ errors });

  const result = db.prepare(
    "INSERT INTO expenses (title, amount, category, note) VALUES (?, ?, ?, ?)"
  ).run(title.trim(), Number(amount), category || "General", note?.trim() || null);

  const row = db.prepare("SELECT * FROM expenses WHERE id = ?").get(result.lastInsertRowid);
  ok(res, row, 201);
});

// PUT /update-expense/:id
app.put("/update-expense/:id", (req, res) => {
  const { id } = req.params;
  const existing = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
  if (!existing) return err(res, "Expense not found", 404);

  const { title, amount, category, note } = req.body;
  const errors = [];
  if (!title?.trim())              errors.push("Title is required");
  if (!amount || Number(amount) <= 0) errors.push("Amount must be greater than 0");
  if (errors.length) return res.status(400).json({ errors });

  db.prepare(
    "UPDATE expenses SET title = ?, amount = ?, category = ?, note = ? WHERE id = ?"
  ).run(title.trim(), Number(amount), category || existing.category, note?.trim() || null, id);

  const updated = db.prepare("SELECT * FROM expenses WHERE id = ?").get(id);
  ok(res, updated);
});

// DELETE /delete-expense/:id
app.delete("/delete-expense/:id", (req, res) => {
  const { id } = req.params;
  const row = db.prepare("SELECT id FROM expenses WHERE id = ?").get(id);
  if (!row) return err(res, "Expense not found", 404);

  db.prepare("DELETE FROM expenses WHERE id = ?").run(id);
  ok(res, { message: "Expense deleted" });
});

// DELETE /delete-expenses  (bulk)
app.delete("/delete-expenses", (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return err(res, "No ids provided");

  const placeholders = ids.map(() => "?").join(",");
  const result = db.prepare(`DELETE FROM expenses WHERE id IN (${placeholders})`).run(...ids);

  ok(res, { message: `${result.changes} expense(s) deleted`, deleted: result.changes });
});

// ══════════════════════════════════════════
//  SUMMARY
// ══════════════════════════════════════════

// GET /summary
app.get("/summary", (req, res) => {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(amount), 0)  AS total,
      COUNT(*)                  AS count,
      COALESCE(AVG(amount), 0)  AS average,
      COALESCE(MAX(amount), 0)  AS max,
      COALESCE(MIN(amount), 0)  AS min
    FROM expenses
  `).get();
  ok(res, row);
});

// ══════════════════════════════════════════
//  DATE FILTER
// ══════════════════════════════════════════

// GET /expenses-by-date?start=YYYY-MM-DD&end=YYYY-MM-DD
app.get("/expenses-by-date", (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return err(res, "start and end query params required");

  const rows = db.prepare(`
    SELECT * FROM expenses
    WHERE date(created_at) BETWEEN date(?) AND date(?)
    ORDER BY created_at DESC
  `).all(start, end);

  ok(res, rows);
});

// ══════════════════════════════════════════
//  CHART DATA
// ══════════════════════════════════════════

// GET /chart-data?range=30  — daily totals for last N days
app.get("/chart-data", (req, res) => {
  const range = Math.min(365, Math.max(1, parseInt(req.query.range) || 30));

  const rows = db.prepare(`
    SELECT
      date(created_at) AS date,
      SUM(amount)      AS total
    FROM expenses
    WHERE date(created_at) >= date('now', ? || ' days')
    GROUP BY date(created_at)
    ORDER BY date ASC
  `).all(`-${range}`);

  ok(res, rows);
});

// GET /chart-data/monthly  — last 12 months
app.get("/chart-data/monthly", (req, res) => {
  const rows = db.prepare(`
    SELECT
      strftime('%Y-%m', created_at) AS month,
      SUM(amount)                   AS total
    FROM expenses
    WHERE created_at >= date('now', '-12 months')
    GROUP BY strftime('%Y-%m', created_at)
    ORDER BY month ASC
  `).all();

  ok(res, rows);
});

// GET /chart-data/category
app.get("/chart-data/category", (req, res) => {
  const rows = db.prepare(`
    SELECT
      category,
      SUM(amount) AS total
    FROM expenses
    GROUP BY category
    ORDER BY total DESC
  `).all();

  ok(res, rows);
});

// ══════════════════════════════════════════
//  CSV EXPORT
// ══════════════════════════════════════════

// GET /export/csv
app.get("/export/csv", (req, res) => {
  const rows = db.prepare("SELECT * FROM expenses ORDER BY created_at DESC").all();

  const header = "id,title,amount,category,note,created_at\n";
  const csvEscape = (v) => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"`
      : s;
  };

  const body = rows.map(r =>
    [r.id, r.title, r.amount, r.category, r.note ?? "", r.created_at]
      .map(csvEscape)
      .join(",")
  ).join("\n");

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", 'attachment; filename="expenses.csv"');
  res.send(header + body);
});

// ── Start ──
app.listen(PORT, () => {
  console.log(`✅ XpenseTracker API running at http://localhost:${PORT}`);
});