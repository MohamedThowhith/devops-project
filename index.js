const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
});

/* ROOT */
app.get("/", (req, res) => {
  res.send("🚀 Expense Tracker API is running");
});

/* HEALTH */
app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

/* DB INIT + MIGRATION */
async function initDB() {
  try {
    /* Create tables if missing */
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
        note TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    /* Migrate old DB safely */
    await pool.query(`
      ALTER TABLE expenses
      ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'General';

      ALTER TABLE expenses
      ADD COLUMN IF NOT EXISTS note TEXT DEFAULT '';

      ALTER TABLE expenses
      ADD COLUMN IF NOT EXISTS created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP;
    `);

    /* Default category */
    await pool.query(`
      INSERT INTO categories(name,color)
      VALUES('General','#6366f1')
      ON CONFLICT(name) DO NOTHING;
    `);

    console.log("✅ Database Ready");
  } catch (err) {
    console.error("❌ DB INIT ERROR:", err.message);
    throw err;
  }
}

/* SUMMARY */
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

/* EXPENSE LIST */
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

    const values = [];
    const where = [];

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
    res.status(500).json({ error: err.message });
  }
});

/* SINGLE */
app.get("/expenses/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM expenses WHERE id=$1",
      [req.params.id]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Not found",
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ADD */
app.post("/add-expense", async (req, res) => {
  try {
    const {
      title,
      amount,
      category,
      note,
    } = req.body;

    if (!title || amount == null) {
      return res.status(400).json({
        error: "title and amount required",
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
    res.status(500).json({
      error: err.message,
    });
  }
});

/* UPDATE */
app.put("/update-expense/:id", async (req, res) => {
  try {
    const {
      title,
      amount,
      category,
      note,
    } = req.body;

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
      [
        title,
        amount,
        category,
        note,
        req.params.id,
      ]
    );

    if (!result.rows.length) {
      return res.status(404).json({
        error: "Not found",
      });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

/* DELETE */
app.delete("/delete-expense/:id", async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM expenses WHERE id=$1",
      [req.params.id]
    );

    res.json({
      message: "Deleted",
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
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
    res.status(500).json({
      error: err.message,
    });
  }
});

/* CATEGORIES */
app.get("/categories", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM categories ORDER BY name"
    );

    res.json(result.rows);
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

app.post("/categories", async (req, res) => {
  try {
    const { name, color } = req.body;

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
    res.status(400).json({
      error: "Category already exists",
    });
  }
});

app.delete("/categories/:id", async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM categories WHERE id=$1",
      [req.params.id]
    );

    res.json({
      message: "Deleted",
    });
  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

/* START */
const PORT = process.env.PORT || 3000;

(async () => {
  try {
    await initDB();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Running on ${PORT}`);
    });
  } catch (err) {
    console.error("Startup failed:", err);
    process.exit(1);
  }
})();