const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

/* ✅ CORS FIX (important for Vercel frontend) */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type"]
}));

app.use(express.json());

/* ✅ PostgreSQL connection (Render compatible) */
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

/* ───────────────── ROOT ROUTE (FIXED) ───────────────── */
app.get("/", (req, res) => {
  res.send("🚀 Expense Tracker API is running");
});

/* ───────────────── HEALTH ───────────────── */
app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

/* ───────────────── DB INIT ───────────────── */
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        color TEXT DEFAULT '#6366f1'
      );

      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        amount NUMERIC NOT NULL,
        category TEXT,
        note TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      INSERT INTO categories (name)
      VALUES ('General')
      ON CONFLICT (name) DO NOTHING
    `);

    console.log("✅ DB Ready");
  } catch (err) {
    console.error("❌ DB INIT ERROR:", err.message);
  }
}

initDB();

/* ───────────────── SUMMARY ───────────────── */
app.get("/summary", async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT 
        COUNT(*) AS count,
        COALESCE(SUM(amount),0) AS total,
        COALESCE(AVG(amount),0) AS average,
        COALESCE(MAX(amount),0) AS max,
        COALESCE(MIN(amount),0) AS min
      FROM expenses
    `);
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── EXPENSES ───────────────── */
app.get("/expenses", async (req, res) => {
  try {
    const { page = 1, limit = 10, search = "", category = "", sort = "id", order = "DESC" } = req.query;
    const offset = (page - 1) * limit;

    let where = [];
    let values = [];

    if (search) {
      values.push(`%${search}%`);
      where.push(`(title ILIKE $${values.length} OR note ILIKE $${values.length})`);
    }

    if (category) {
      values.push(category);
      where.push(`category = $${values.length}`);
    }

    const whereClause = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const data = await pool.query(
      `SELECT * FROM expenses
       ${whereClause}
       ORDER BY ${sort} ${order}
       LIMIT $${values.length + 1}
       OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    );

    const count = await pool.query(
      `SELECT COUNT(*) FROM expenses ${whereClause}`,
      values
    );

    res.json({
      data: data.rows,
      pagination: {
        page: Number(page),
        total: Number(count.rows[0].count),
        totalPages: Math.ceil(count.rows[0].count / limit),
      },
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── SINGLE ───────────────── */
app.get("/expenses/:id", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM expenses WHERE id=$1", [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── ADD ───────────────── */
app.post("/add-expense", async (req, res) => {
  try {
    const { title, amount, category, note } = req.body;

    if (!title || !amount) {
      return res.status(400).json({ error: "Required fields missing" });
    }

    const r = await pool.query(
      "INSERT INTO expenses (title, amount, category, note) VALUES ($1,$2,$3,$4) RETURNING *",
      [title, amount, category || "General", note || ""]
    );

    res.json(r.rows[0]);

  } catch (err) {
    console.error("❌ ADD ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── UPDATE ───────────────── */
app.put("/update-expense/:id", async (req, res) => {
  try {
    const { title, amount, category, note } = req.body;

    const r = await pool.query(
      `UPDATE expenses SET title=$1, amount=$2, category=$3, note=$4 WHERE id=$5 RETURNING *`,
      [title, amount, category, note, req.params.id]
    );

    res.json(r.rows[0]);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── DELETE ───────────────── */
app.delete("/delete-expense/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM expenses WHERE id=$1", [req.params.id]);
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── BULK DELETE ───────────────── */
app.delete("/delete-expenses", async (req, res) => {
  try {
    const { ids } = req.body;

    if (!ids || !ids.length) {
      return res.status(400).json({ error: "No IDs provided" });
    }

    await pool.query(`DELETE FROM expenses WHERE id = ANY($1::int[])`, [ids]);

    res.json({ message: "Deleted selected expenses" });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── CATEGORIES ───────────────── */
app.get("/categories", async (req, res) => {
  try {
    const r = await pool.query("SELECT * FROM categories ORDER BY name");
    res.json(r.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post("/categories", async (req, res) => {
  try {
    const { name, color } = req.body;

    const r = await pool.query(
      "INSERT INTO categories (name,color) VALUES ($1,$2) RETURNING *",
      [name, color]
    );

    res.json(r.rows[0]);

  } catch (err) {
    res.status(400).json({ error: "Category already exists" });
  }
});

app.delete("/categories/:id", async (req, res) => {
  try {
    await pool.query("DELETE FROM categories WHERE id=$1", [req.params.id]);
    res.json({ message: "Deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── SERVER ───────────────── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});