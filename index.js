const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

/* ───────────────── DB ───────────────── */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

/* ───────────────── ROOT ───────────────── */

app.get("/", (req, res) => {
  res.send("🚀 Expense Tracker API Running");
});

app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

/* ───────────────── AUTH MIDDLEWARE ───────────────── */

function authenticateToken(req, res, next) {

  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({
      error: "Access denied"
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

  } catch {
    res.status(403).json({
      error: "Invalid token"
    });
  }
}

/* ───────────────── INIT DB ───────────────── */

async function initDB() {

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      color TEXT DEFAULT '#6366f1'
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS expenses (
      id SERIAL PRIMARY KEY,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      amount NUMERIC NOT NULL,
      category TEXT DEFAULT 'General',
      note TEXT DEFAULT '',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);

  console.log("✅ Database Ready");
}

/* ───────────────── REGISTER ───────────────── */

app.post("/register", async (req, res) => {

  try {

    const { name, email, password } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        error: "All fields required"
      });
    }

    const existing = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (existing.rows.length) {
      return res.status(400).json({
        error: "Email already exists"
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
        email
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d"
      }
    );

    res.json({
      token,
      user: user.rows[0]
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
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
        error: "Invalid email"
      });
    }

    const valid = await bcrypt.compare(
      password,
      user.rows[0].password
    );

    if (!valid) {
      return res.status(400).json({
        error: "Invalid password"
      });
    }

    const token = jwt.sign(
      {
        id: user.rows[0].id,
        email
      },
      process.env.JWT_SECRET,
      {
        expiresIn: "7d"
      }
    );

    res.json({
      token,
      user: {
        id: user.rows[0].id,
        name: user.rows[0].name,
        email: user.rows[0].email
      }
    });

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
});

/* ───────────────── SUMMARY ───────────────── */

app.get("/summary", authenticateToken, async (req, res) => {

  const r = await pool.query(
    `
    SELECT
      COUNT(*) count,
      COALESCE(SUM(amount),0) total,
      COALESCE(AVG(amount),0) average,
      COALESCE(MAX(amount),0) max,
      COALESCE(MIN(amount),0) min
    FROM expenses
    WHERE user_id=$1
    `,
    [req.user.id]
  );

  res.json(r.rows[0]);
});

/* ───────────────── GET EXPENSES ───────────────── */

app.get("/expenses", authenticateToken, async (req, res) => {

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
    data: r.rows
  });
});

/* ───────────────── ADD EXPENSE ───────────────── */

app.post("/add-expense", authenticateToken, async (req, res) => {

  try {

    const {
      title,
      amount,
      category,
      note
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
        note || ""
      ]
    );

    res.json(r.rows[0]);

  } catch (err) {

    console.error(err);

    res.status(500).json({
      error: err.message
    });
  }
});

/* ───────────────── DELETE EXPENSE ───────────────── */

app.delete("/delete-expense/:id", authenticateToken, async (req, res) => {

  await pool.query(
    `
    DELETE FROM expenses
    WHERE id=$1 AND user_id=$2
    `,
    [
      req.params.id,
      req.user.id
    ]
  );

  res.json({
    message: "Deleted"
  });
});

/* ───────────────── CATEGORIES ───────────────── */

app.get("/categories", authenticateToken, async (req, res) => {

  let r = await pool.query(
    `
    SELECT *
    FROM categories
    WHERE user_id=$1
    ORDER BY name
    `,
    [req.user.id]
  );

  if (!r.rows.length) {

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
      [req.user.id]
    );

    r = await pool.query(
      `
      SELECT *
      FROM categories
      WHERE user_id=$1
      ORDER BY name
      `,
      [req.user.id]
    );
  }

  res.json(r.rows);
});

/* ───────────────── START ───────────────── */

const PORT = process.env.PORT || 3000;

(async () => {

  await initDB();

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Running on ${PORT}`);
  });

})();