const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ──
app.use(cors());
app.use(express.json());

// ── Database Setup ──
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Alternatively, use individual fields:
  // host:     process.env.PGHOST     || "localhost",
  // port:     process.env.PGPORT     || 5432,
  // user:     process.env.PGUSER     || "postgres",
  // password: process.env.PGPASSWORD || "",
  // database: process.env.PGDATABASE || "xpensetracker",
  ssl: process.env.DATABASE_URL?.includes("localhost")
    ? false
    : { rejectUnauthorized: false },
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id    SERIAL PRIMARY KEY,
      name  TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#6366f1'
    );

    CREATE TABLE IF NOT EXISTS expenses (
      id         SERIAL PRIMARY KEY,
      title      TEXT NOT NULL,
      amount     NUMERIC NOT NULL CHECK(amount > 0),
      category   TEXT NOT NULL DEFAULT 'General',
      note       TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  // Seed default categories if none exist
  await pool.query(`
    INSERT INTO categories (name, color) VALUES
      ('General',       '#6366f1'),
      ('Food',          '#f59e0b'),
      ('Transport',     '#10b981'),
      ('Shopping',      '#ec4899'),
      ('Entertainment', '#8b5cf6'),
      ('Health',        '#ef4444'),
      ('Bills',         '#3b82f6'),
      ('Education',     '#14b8a6')
    ON CONFLICT (name) DO NOTHING;
  `);

  console.log("✅ Database initialised");
}

// ── Helpers ──
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
app.get("/categories", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM categories ORDER BY name ASC");
    ok(res, rows);
  } catch (e) {
    console.error(e);
    err(res, "Failed to fetch categories", 500);
  }
});

// POST /categories
app.post("/categories", async (req, res) => {
  const { name, color } = req.body;
  if (!name?.trim()) return err(res, "Category name is required");

  try {
    const { rows } = await pool.query(
      "INSERT INTO categories (name, color) VALUES ($1, $2) RETURNING *",
      [name.trim(), color || "#6366f1"]
    );
    ok(res, rows[0], 201);
  } catch (e) {
    if (e.code === "23505") return err(res, "Category already exists"); // unique_violation
    console.error(e);
    err(res, "Failed to create category", 500);
  }
});

// DELETE /categories/:id
app.delete("/categories/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query("SELECT * FROM categories WHERE id = $1", [id]);
    if (!rows.length) return err(res, "Category not found", 404);

    await pool.query("DELETE FROM categories WHERE id = $1", [id]);
    ok(res, { message: "Category deleted" });
  } catch (e) {
    console.error(e);
    err(res, "Failed to delete category", 500);
  }
});

// ══════════════════════════════════════════
//  EXPENSES
// ══════════════════════════════════════════

// GET /expenses — paginated, searchable, sortable, filterable by category
app.get("/expenses", async (req, res) => {
  const page     = Math.max(1, parseInt(req.query.page)  || 1);
  const limit    = Math.min(100, parseInt(req.query.limit) || 15);
  const offset   = (page - 1) * limit;
  const search   = req.query.search   || "";
  const category = req.query.category || "";
  const sortMap  = { id: "id", amount: "amount", title: "title" };
  const sort     = sortMap[req.query.sort] || "id";
  const order    = req.query.order === "ASC" ? "ASC" : "DESC";

  const conditions = [];
  const params     = [];

  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(title ILIKE $${params.length} OR note ILIKE $${params.length})`);
    // ILIKE shares the same param index for both columns
  }
  if (category) {
    params.push(category);
    conditions.push(`category = $${params.length}`);
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

  try {
    const countResult = await pool.query(
      `SELECT COUNT(*) AS n FROM expenses ${where}`,
      params
    );
    const total = parseInt(countResult.rows[0].n);

    const dataParams = [...params, limit, offset];
    const { rows } = await pool.query(
      `SELECT * FROM expenses ${where} ORDER BY ${sort} ${order} LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams
    );

    ok(res, {
      data: rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (e) {
    console.error(e);
    err(res, "Failed to fetch expenses", 500);
  }
});

// GET /expenses/:id
app.get("/expenses/:id", async (req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM expenses WHERE id = $1", [req.params.id]);
    if (!rows.length) return err(res, "Expense not found", 404);
    ok(res, rows[0]);
  } catch (e) {
    console.error(e);
    err(res, "Failed to fetch expense", 500);
  }
});

// POST /add-expense
app.post("/add-expense", async (req, res) => {
  const { title, amount, category, note } = req.body;
  const errors = [];
  if (!title?.trim())                  errors.push("Title is required");
  if (!amount || Number(amount) <= 0)  errors.push("Amount must be greater than 0");
  if (errors.length) return res.status(400).json({ errors });

  try {
    const { rows } = await pool.query(
      "INSERT INTO expenses (title, amount, category, note) VALUES ($1, $2, $3, $4) RETURNING *",
      [title.trim(), Number(amount), category || "General", note?.trim() || null]
    );
    ok(res, rows[0], 201);
  } catch (e) {
    console.error(e);
    err(res, "Failed to create expense", 500);
  }
});

// PUT /update-expense/:id
app.put("/update-expense/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const existing = await pool.query("SELECT * FROM expenses WHERE id = $1", [id]);
    if (!existing.rows.length) return err(res, "Expense not found", 404);

    const { title, amount, category, note } = req.body;
    const errors = [];
    if (!title?.trim())                 errors.push("Title is required");
    if (!amount || Number(amount) <= 0) errors.push("Amount must be greater than 0");
    if (errors.length) return res.status(400).json({ errors });

    const { rows } = await pool.query(
      "UPDATE expenses SET title = $1, amount = $2, category = $3, note = $4 WHERE id = $5 RETURNING *",
      [
        title.trim(),
        Number(amount),
        category || existing.rows[0].category,
        note?.trim() || null,
        id,
      ]
    );
    ok(res, rows[0]);
  } catch (e) {
    console.error(e);
    err(res, "Failed to update expense", 500);
  }
});

// DELETE /delete-expense/:id
app.delete("/delete-expense/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query("SELECT id FROM expenses WHERE id = $1", [id]);
    if (!rows.length) return err(res, "Expense not found", 404);

    await pool.query("DELETE FROM expenses WHERE id = $1", [id]);
    ok(res, { message: "Expense deleted" });
  } catch (e) {
    console.error(e);
    err(res, "Failed to delete expense", 500);
  }
});

// DELETE /delete-expenses (bulk)
app.delete("/delete-expenses", async (req, res) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length) return err(res, "No ids provided");

  try {
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
    const result = await pool.query(
      `DELETE FROM expenses WHERE id IN (${placeholders})`,
      ids
    );
    ok(res, {
      message: `${result.rowCount} expense(s) deleted`,
      deleted: result.rowCount,
    });
  } catch (e) {
    console.error(e);
    err(res, "Failed to delete expenses", 500);
  }
});

// ══════════════════════════════════════════
//  SUMMARY
// ══════════════════════════════════════════

// GET /summary
app.get("/summary", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        COALESCE(SUM(amount), 0)  AS total,
        COUNT(*)                  AS count,
        COALESCE(AVG(amount), 0)  AS average,
        COALESCE(MAX(amount), 0)  AS max,
        COALESCE(MIN(amount), 0)  AS min
      FROM expenses
    `);
    ok(res, rows[0]);
  } catch (e) {
    console.error(e);
    err(res, "Failed to fetch summary", 500);
  }
});

// ══════════════════════════════════════════
//  DATE FILTER
// ══════════════════════════════════════════

// GET /expenses-by-date?start=YYYY-MM-DD&end=YYYY-MM-DD
app.get("/expenses-by-date", async (req, res) => {
  const { start, end } = req.query;
  if (!start || !end) return err(res, "start and end query params required");

  try {
    const { rows } = await pool.query(
      `SELECT * FROM expenses
       WHERE created_at::date BETWEEN $1::date AND $2::date
       ORDER BY created_at DESC`,
      [start, end]
    );
    ok(res, rows);
  } catch (e) {
    console.error(e);
    err(res, "Failed to fetch expenses by date", 500);
  }
});

// ══════════════════════════════════════════
//  CHART DATA
// ══════════════════════════════════════════

// GET /chart-data?range=30 — daily totals for last N days
app.get("/chart-data", async (req, res) => {
  const range = Math.min(365, Math.max(1, parseInt(req.query.range) || 30));

  try {
    const { rows } = await pool.query(
      `SELECT
         created_at::date AS date,
         SUM(amount)      AS total
       FROM expenses
       WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
       GROUP BY created_at::date
       ORDER BY date ASC`,
      [range]
    );
    ok(res, rows);
  } catch (e) {
    console.error(e);
    err(res, "Failed to fetch chart data", 500);
  }
});

// GET /chart-data/monthly — last 12 months
app.get("/chart-data/monthly", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        TO_CHAR(created_at, 'YYYY-MM') AS month,
        SUM(amount)                    AS total
      FROM expenses
      WHERE created_at >= NOW() - INTERVAL '12 months'
      GROUP BY TO_CHAR(created_at, 'YYYY-MM')
      ORDER BY month ASC
    `);
    ok(res, rows);
  } catch (e) {
    console.error(e);
    err(res, "Failed to fetch monthly chart data", 500);
  }
});

// GET /chart-data/category
app.get("/chart-data/category", async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        category,
        SUM(amount) AS total
      FROM expenses
      GROUP BY category
      ORDER BY total DESC
    `);
    ok(res, rows);
  } catch (e) {
    console.error(e);
    err(res, "Failed to fetch category chart data", 500);
  }
});

// ══════════════════════════════════════════
//  CSV EXPORT
// ══════════════════════════════════════════

// GET /export/csv
app.get("/export/csv", async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT * FROM expenses ORDER BY created_at DESC"
    );

    const csvEscape = (v) => {
      const s = String(v ?? "");
      return s.includes(",") || s.includes('"') || s.includes("\n")
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    const header = "id,title,amount,category,note,created_at\n";
    const body   = rows
      .map((r) =>
        [r.id, r.title, r.amount, r.category, r.note ?? "", r.created_at]
          .map(csvEscape)
          .join(",")
      )
      .join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="expenses.csv"');
    res.send(header + body);
  } catch (e) {
    console.error(e);
    err(res, "Failed to export CSV", 500);
  }
});

// ── Start ──
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ XpenseTracker API running at http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error("❌ Failed to initialise database:", e);
    process.exit(1);
  });