const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

/* ───────────────── MIDDLEWARE ───────────────── */
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type"],
  })
);

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
  res.status(200).send("🚀 Expense Tracker API is running");
});

/* ───────────────── HEALTH ───────────────── */
app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

/* ───────────────── INIT DB + MIGRATION ───────────────── */
async function initDB() {
  try {
    console.log("🔄 Connecting DB...");

    /* categories table */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        color TEXT DEFAULT '#6366f1'
      )
    `);

    /* base expenses table */
    await pool.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        amount NUMERIC NOT NULL
      )
    `);

    /* migrations */
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

    /* default category */
    await pool.query(`
      INSERT INTO categories(name,color)
      VALUES('General','#6366f1')
      ON CONFLICT(name) DO NOTHING
    `);

    /* verify columns */
    const check = await pool.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name='expenses'
      ORDER BY ordinal_position
    `);

    console.log(
      "✅ expenses columns:",
      check.rows.map((r) => r.column_name)
    );

    console.log("✅ Database Ready");
  } catch (err) {
    console.error("❌ DB INIT ERROR:", err);
    throw err;
  }
}

/* ───────────────── SUMMARY ───────────────── */
app.get("/summary", async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) AS count,
        COALESCE(SUM(amount),0) AS total,
        COALESCE(AVG(amount),0) AS average,
        COALESCE(MAX(amount),0) AS max,
        COALESCE(MIN(amount),0) AS min
      FROM expenses
    `);

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── GET EXPENSES ───────────────── */
app.get("/expenses", async (req, res) => {
  try {
    const page = Number(req.query.page || 1);
    const limit = Number(req.query.limit || 10);
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

    const whereClause =
      where.length > 0
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
    console.error("GET EXPENSES ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── SINGLE EXPENSE ───────────────── */
app.get("/expenses/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM expenses WHERE id=$1",
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Expense not found",
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("GET SINGLE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── ADD EXPENSE ───────────────── */
app.post("/add-expense", async (req, res) => {
  try {
    const { title, amount, category, note } = req.body;

    if (!title || amount == null) {
      return res.status(400).json({
        error: "title and amount are required",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO expenses(title, amount, category, note)
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

    res.json(result.rows[0]);
  } catch (err) {
    console.error("ADD ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── UPDATE EXPENSE ───────────────── */
app.put("/update-expense/:id", async (req, res) => {
  try {
    const { title, amount, category, note } = req.body;

    const result = await pool.query(
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

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Expense not found",
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error("UPDATE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── DELETE SINGLE ───────────────── */
app.delete("/delete-expense/:id", async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM expenses WHERE id=$1",
      [req.params.id]
    );

    res.json({
      message: "Expense deleted",
    });
  } catch (err) {
    console.error("DELETE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── BULK DELETE ───────────────── */
app.delete("/delete-expenses", async (req, res) => {
  try {
    const { ids } = req.body;

    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({
        error: "No IDs provided",
      });
    }

    await pool.query(
      "DELETE FROM expenses WHERE id = ANY($1::int[])",
      [ids]
    );

    res.json({
      message: "Selected expenses deleted",
    });
  } catch (err) {
    console.error("BULK DELETE ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── GET CATEGORIES ───────────────── */
app.get("/categories", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM categories ORDER BY name"
    );

    res.json(result.rows);
  } catch (err) {
    console.error("GET CATEGORIES ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── ADD CATEGORY ───────────────── */
app.post("/categories", async (req, res) => {
  try {
    const { name, color } = req.body;

    if (!name) {
      return res.status(400).json({
        error: "Category name required",
      });
    }

    const result = await pool.query(
      `
      INSERT INTO categories(name,color)
      VALUES($1,$2)
      RETURNING *
      `,
      [name, color || "#6366f1"]
    );

    res.json(result.rows[0]);
  } catch (err) {
    console.error("ADD CATEGORY ERROR:", err);
    res.status(400).json({
      error: "Category already exists",
    });
  }
});

/* ───────────────── DELETE CATEGORY ───────────────── */
app.delete("/categories/:id", async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM categories WHERE id=$1",
      [req.params.id]
    );

    res.json({
      message: "Category deleted",
    });
  } catch (err) {
    console.error("DELETE CATEGORY ERROR:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── START SERVER ───────────────── */
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await initDB();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on port ${PORT}`);
    });
  } catch (err) {
    console.error("❌ Startup failed:", err);
    process.exit(1);
  }
})();