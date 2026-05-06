const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { Parser } = require("json2csv");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

/* ───────────────── DB ───────────────── */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
});

/* ───────────────── ROOT ───────────────── */
app.get("/", (req, res) => {
  res.send("🚀 Expense Tracker API is running");
});

app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

/* ───────────────── INIT DB ───────────────── */
async function initDB() {
  try {
    console.log("🔄 Connecting DB...");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        color TEXT DEFAULT '#6366f1'
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        amount NUMERIC NOT NULL
      )
    `);

    await pool.query(`
      ALTER TABLE expenses
      ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'General'
    `);

    await pool.query(`
      ALTER TABLE expenses
      ADD COLUMN IF NOT EXISTS note TEXT DEFAULT ''
    `);

    await pool.query(`
      ALTER TABLE expenses
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    `);

    await pool.query(`
      INSERT INTO categories(name,color)
      VALUES('General','#6366f1')
      ON CONFLICT(name) DO NOTHING
    `);

    console.log("✅ Database Ready");
  } catch (err) {
    console.error("DB INIT ERROR:", err);
    throw err;
  }
}

/* ───────────────── SUMMARY ───────────────── */
app.get("/summary", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        COUNT(*) count,
        COALESCE(SUM(amount),0) total,
        COALESCE(AVG(amount),0) average,
        COALESCE(MAX(amount),0) max,
        COALESCE(MIN(amount),0) min
      FROM expenses
    `);

    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── GET EXPENSES ───────────────── */
app.get("/expenses", async (req, res) => {
  try {
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 15);
    const search = req.query.search || "";
    const category = req.query.category || "";
    const sort = req.query.sort || "id";
    const order =
      (req.query.order || "DESC").toUpperCase() === "ASC"
        ? "ASC"
        : "DESC";

    const allowedSort = [
      "id",
      "title",
      "amount",
      "category",
      "created_at",
    ];

    const sortColumn = allowedSort.includes(sort)
      ? sort
      : "id";

    const offset = (page - 1) * limit;

    let values = [];
    let where = [];

    if (search) {
      values.push(`%${search}%`);
      where.push(
        `(title ILIKE $${values.length} OR note ILIKE $${values.length})`
      );
    }

    if (category) {
      values.push(category);
      where.push(`category = $${values.length}`);
    }

    const whereClause = where.length
      ? `WHERE ${where.join(" AND ")}`
      : "";

    const data = await pool.query(
      `
      SELECT * FROM expenses
      ${whereClause}
      ORDER BY ${sortColumn} ${order}
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
      `,
      [...values, limit, offset]
    );

    const count = await pool.query(
      `SELECT COUNT(*) FROM expenses ${whereClause}`,
      values
    );

    const total = Number(count.rows[0].count);

    res.json({
      data: data.rows,
      pagination: {
        page,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* SINGLE */
app.get("/expenses/:id", async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM expenses WHERE id=$1",
      [req.params.id]
    );

    if (!r.rows.length) {
      return res.status(404).json({
        error: "Expense not found",
      });
    }

    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ADD */
app.post("/add-expense", async (req, res) => {
  try {
    const { title, amount, category, note } = req.body;

    if (!title || amount == null) {
      return res.status(400).json({
        error: "Title and amount required",
      });
    }

    const r = await pool.query(
      `
      INSERT INTO expenses(title,amount,category,note)
      VALUES($1,$2,$3,$4)
      RETURNING *
      `,
      [
        title,
        amount,
        category || "General",
        note || "",
      ]
    );

    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* UPDATE */
app.put("/update-expense/:id", async (req, res) => {
  try {
    const { title, amount, category, note } = req.body;

    const r = await pool.query(
      `
      UPDATE expenses
      SET title=$1,
          amount=$2,
          category=$3,
          note=$4
      WHERE id=$5
      RETURNING *
      `,
      [title, amount, category, note, req.params.id]
    );

    if (!r.rows.length) {
      return res.status(404).json({
        error: "Expense not found",
      });
    }

    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* DELETE */
app.delete("/delete-expense/:id", async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM expenses WHERE id=$1",
      [req.params.id]
    );

    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* BULK DELETE */
app.delete("/delete-expenses", async (req, res) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || !ids.length) {
      return res.status(400).json({
        error: "No IDs provided",
      });
    }

    await pool.query(
      "DELETE FROM expenses WHERE id = ANY($1::int[])",
      [ids]
    );

    res.json({
      message: "Deleted selected expenses",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── DATE FILTER ───────────────── */
app.get("/expenses-by-date", async (req, res) => {
  try {
    const { start, end } = req.query;

    const r = await pool.query(
      `
      SELECT *
      FROM expenses
      WHERE created_at::date BETWEEN $1 AND $2
      ORDER BY created_at DESC
      `,
      [start, end]
    );

    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── CHART DAILY ───────────────── */
app.get("/chart-data", async (req, res) => {
  try {
    const range = Number(req.query.range || 30);

    const r = await pool.query(
      `
      SELECT
        TO_CHAR(created_at,'DD Mon') AS date,
        SUM(amount)::numeric AS total
      FROM expenses
      WHERE created_at >= NOW() - ($1 || ' days')::interval
      GROUP BY DATE(created_at), TO_CHAR(created_at,'DD Mon')
      ORDER BY DATE(created_at)
      `,
      [range]
    );

    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* MONTHLY */
app.get("/chart-data/monthly", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        TO_CHAR(created_at,'Mon YYYY') AS month,
        SUM(amount)::numeric AS total
      FROM expenses
      GROUP BY DATE_TRUNC('month', created_at), TO_CHAR(created_at,'Mon YYYY')
      ORDER BY DATE_TRUNC('month', created_at)
    `);

    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* CATEGORY */
app.get("/chart-data/category", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        category,
        SUM(amount)::numeric AS total
      FROM expenses
      GROUP BY category
      ORDER BY total DESC
    `);

    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── EXPORT CSV ───────────────── */
app.get("/export/csv", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        id,
        title,
        amount,
        category,
        note,
        created_at
      FROM expenses
      ORDER BY created_at DESC
    `);

    const parser = new Parser();
    const csv = parser.parse(r.rows);

    res.header("Content-Type", "text/csv");
    res.attachment("expenses.csv");
    res.send(csv);
  } catch (err) {
    res.status(500).send("Export failed");
  }
});

/* ───────────────── CATEGORIES ───────────────── */
app.get("/categories", async (req, res) => {
  const r = await pool.query(
    "SELECT * FROM categories ORDER BY name"
  );
  res.json(r.rows);
});

app.post("/categories", async (req, res) => {
  try {
    const { name, color } = req.body;

    const r = await pool.query(
      `
      INSERT INTO categories(name,color)
      VALUES($1,$2)
      RETURNING *
      `,
      [name, color || "#6366f1"]
    );

    res.json(r.rows[0]);
  } catch {
    res.status(400).json({
      error: "Category already exists",
    });
  }
});

app.delete("/categories/:id", async (req, res) => {
  await pool.query(
    "DELETE FROM categories WHERE id=$1",
    [req.params.id]
  );

  res.json({ message: "Deleted" });
});

/* ───────────────── START ───────────────── */
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await initDB();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Running on ${PORT}`);
    });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
})();