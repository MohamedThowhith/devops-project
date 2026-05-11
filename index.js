require("dotenv").config();

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Parser } = require("json2csv");

const app = express();

app.use(cors());
app.use(express.json());

/* ───────────────── CONFIG ───────────────── */

const PORT = process.env.PORT || 3000;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

/* ───────────────── AUTH MIDDLEWARE ───────────────── */

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      error: "Access denied",
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    const verified = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    req.user = verified;

    next();

  } catch (err) {
    return res.status(403).json({
      error: "Invalid token",
    });
  }
}

/* ───────────────── DATABASE INIT ───────────────── */

async function initDB() {

  /* USERS */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);

  /* CATEGORIES */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#6366f1'
    )
  `);

  /* EXPENSES */
  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER,
      title TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      category TEXT DEFAULT 'General',
      note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  /* SAFE MIGRATIONS */

  await pool.query(`
    ALTER TABLE expenses
    ADD COLUMN IF NOT EXISTS user_id INTEGER
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
    ALTER TABLE categories
    ADD COLUMN IF NOT EXISTS user_id INTEGER
  `);

  console.log("✅ Database Ready");
}

/* ───────────────── ROOT ───────────────── */

app.get("/", (req, res) => {
  res.send("🚀 Expense Tracker API Running");
});

/* ───────────────── REGISTER ───────────────── */

app.post("/register", async (req, res) => {

  try {

    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        error: "All fields required",
      });
    }

    const existing = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (existing.rows.length) {
      return res.status(400).json({
        error: "Email already exists",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await pool.query(
      `
      INSERT INTO users(name,email,password)
      VALUES($1,$2,$3)
      RETURNING id,name,email
      `,
      [name, email, hashedPassword]
    );

    const userId = user.rows[0].id;

    /* DEFAULT CATEGORIES */

    await pool.query(
      `
      INSERT INTO categories(user_id,name,color)
      VALUES
      ($1,'Food','#ff6b6b'),
      ($1,'Travel','#4ecdc4'),
      ($1,'Shopping','#ffe66d'),
      ($1,'Bills','#5f27cd'),
      ($1,'Entertainment','#ff9f43'),
      ($1,'General','#6366f1')
      `,
      [userId]
    );

    const token = jwt.sign(
      {
        id: userId,
        email,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      }
    );

    res.json({
      token,
      user: user.rows[0],
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message,
    });
  }
});

/* ───────────────── LOGIN ───────────────── */

app.post("/login", async (req, res) => {

  try {

    const { email, password } = req.body;

    const user = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (!user.rows.length) {
      return res.status(400).json({
        error: "Invalid email",
      });
    }

    const valid = await bcrypt.compare(
      password,
      user.rows[0].password
    );

    if (!valid) {
      return res.status(400).json({
        error: "Invalid password",
      });
    }

    const token = jwt.sign(
      {
        id: user.rows[0].id,
        email,
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d",
      }
    );

    res.json({
      token,
      user: {
        id: user.rows[0].id,
        name: user.rows[0].name,
        email: user.rows[0].email,
      },
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message,
    });
  }
});

/* ───────────────── SUMMARY ───────────────── */

app.get("/summary", authenticateToken, async (req, res) => {

  try {

    const r = await pool.query(
      `
      SELECT
        COUNT(*)::int AS count,
        COALESCE(SUM(amount),0)::float AS total,
        COALESCE(AVG(amount),0)::float AS average,
        COALESCE(MAX(amount),0)::float AS max,
        COALESCE(MIN(amount),0)::float AS min
      FROM expenses
      WHERE user_id=$1
      `,
      [req.user.id]
    );

    res.json(r.rows[0]);

  } catch (err) {

    res.status(500).json({
      error: err.message,
    });
  }
});

/* ───────────────── GET EXPENSES ───────────────── */

app.get("/expenses", authenticateToken, async (req, res) => {

  try {

    const r = await pool.query(
      `
      SELECT *
      FROM expenses
      WHERE user_id=$1
      ORDER BY created_at DESC
      `,
      [req.user.id]
    );

    res.json({
      data: r.rows,
      pagination: {
        page: 1,
        total: r.rows.length,
        totalPages: 1,
      },
    });

  } catch (err) {

    res.status(500).json({
      error: err.message,
    });
  }
});

/* ───────────────── ADD EXPENSE ───────────────── */

app.post("/add-expense", authenticateToken, async (req, res) => {

  try {

    const {
      title,
      amount,
      category,
      note,
    } = req.body;

    const r = await pool.query(
      `
      INSERT INTO expenses(
        user_id,
        title,
        amount,
        category,
        note
      )
      VALUES($1,$2,$3,$4,$5)
      RETURNING *
      `,
      [
        req.user.id,
        title,
        amount,
        category || "General",
        note || "",
      ]
    );

    res.json(r.rows[0]);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message,
    });
  }
});

/* ───────────────── DELETE EXPENSE ───────────────── */

app.delete("/delete-expense/:id", authenticateToken, async (req, res) => {

  try {

    await pool.query(
      `
      DELETE FROM expenses
      WHERE id=$1
      AND user_id=$2
      `,
      [req.params.id, req.user.id]
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

/* ───────────────── CATEGORIES ───────────────── */

app.get("/categories", authenticateToken, async (req, res) => {

  try {

    const r = await pool.query(
      `
      SELECT *
      FROM categories
      WHERE user_id=$1
      ORDER BY name
      `,
      [req.user.id]
    );

    res.json(r.rows);

  } catch (err) {

    res.status(500).json({
      error: err.message,
    });
  }
});

/* ───────────────── ADD CATEGORY ───────────────── */

app.post("/categories", authenticateToken, async (req, res) => {

  try {

    const { name, color } = req.body;

    const r = await pool.query(
      `
      INSERT INTO categories(user_id,name,color)
      VALUES($1,$2,$3)
      RETURNING *
      `,
      [
        req.user.id,
        name,
        color || "#6366f1",
      ]
    );

    res.json(r.rows[0]);

  } catch (err) {

    res.status(500).json({
      error: err.message,
    });
  }
});

/* ───────────────── EXPORT CSV ───────────────── */

app.get("/export/csv", authenticateToken, async (req, res) => {

  try {

    const r = await pool.query(
      `
      SELECT
      title,
      amount,
      category,
      note,
      created_at
      FROM expenses
      WHERE user_id=$1
      ORDER BY created_at DESC
      `,
      [req.user.id]
    );

    const parser = new Parser();

    const csv = parser.parse(r.rows);

    res.header("Content-Type", "text/csv");

    res.attachment("expenses.csv");

    res.send(csv);

  } catch (err) {

    res.status(500).send("Export failed");
  }
});

/* ───────────────── START SERVER ───────────────── */

async function startServer() {

  try {

    await initDB();

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`🚀 Server running on ${PORT}`);
    });

  } catch (err) {

    console.error(err);

    process.exit(1);
  }
}

startServer();