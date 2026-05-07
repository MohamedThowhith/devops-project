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
  ssl: { rejectUnauthorized: false }
});

/* ───────────────── ROOT ───────────────── */

app.get("/", (req, res) => res.send("🚀 Expense Tracker API Running"));
app.get("/health", (req, res) => res.json({ status: "OK" }));

/* ───────────────── AUTH MIDDLEWARE ───────────────── */

function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "Access denied" });

  const token = authHeader.split(" ")[1];
  try {
    req.user = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch {
    res.status(403).json({ error: "Invalid token" });
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

    if (!name || !email || !password)
      return res.status(400).json({ error: "All fields required" });

    const existing = await pool.query(
      "SELECT * FROM users WHERE email=$1", [email]
    );
    if (existing.rows.length)
      return res.status(400).json({ error: "Email already exists" });

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await pool.query(
      `INSERT INTO users(name,email,password) VALUES($1,$2,$3) RETURNING id,name,email`,
      [name, email, hashedPassword]
    );

    const userId = user.rows[0].id;

    await pool.query(
      `INSERT INTO categories(user_id,name,color) VALUES
        ($1,'Food','#ff6b6b'),
        ($1,'Travel','#4ecdc4'),
        ($1,'Shopping','#ffe66d'),
        ($1,'Bills','#5f27cd'),
        ($1,'Entertainment','#ff9f43'),
        ($1,'General','#6366f1')`,
      [userId]
    );

    const token = jwt.sign(
      { id: userId, email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token, user: user.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── LOGIN ───────────────── */

app.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;

    const user = await pool.query(
      "SELECT * FROM users WHERE email=$1", [email]
    );
    if (!user.rows.length)
      return res.status(400).json({ error: "Invalid email" });

    const valid = await bcrypt.compare(password, user.rows[0].password);
    if (!valid)
      return res.status(400).json({ error: "Invalid password" });

    const token = jwt.sign(
      { id: user.rows[0].id, email },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
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
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── SUMMARY ───────────────── */

app.get("/summary", authenticateToken, async (req, res) => {
  const r = await pool.query(
    `SELECT
      COUNT(*)::int AS count,
      COALESCE(SUM(amount),0)::float AS total,
      COALESCE(AVG(amount),0)::float AS average,
      COALESCE(MAX(amount),0)::float AS max,
      COALESCE(MIN(amount),0)::float AS min
    FROM expenses WHERE user_id=$1`,
    [req.user.id]
  );
  res.json(r.rows[0]);
});

/* ───────────────── GET EXPENSES (with pagination, search, filter, sort) ───────────────── */

app.get("/expenses", authenticateToken, async (req, res) => {
  try {
    const page     = parseInt(req.query.page)  || 1;
    const limit    = parseInt(req.query.limit) || 15;
    const offset   = (page - 1) * limit;
    const search   = req.query.search   || "";
    const category = req.query.category || "";
    const sort     = req.query.sort     || "id";

    // Whitelist sort columns to prevent SQL injection
    const sortMap = {
      id:     "created_at DESC",
      amount: "amount DESC",
      title:  "title ASC"
    };
    const orderBy = sortMap[sort] || "created_at DESC";

    const conditions = ["e.user_id=$1"];
    const values     = [req.user.id];
    let   idx        = 2;

    if (search) {
      conditions.push(`(e.title ILIKE $${idx} OR e.note ILIKE $${idx})`);
      values.push(`%${search}%`);
      idx++;
    }

    if (category) {
      conditions.push(`e.category=$${idx}`);
      values.push(category);
      idx++;
    }

    const where = conditions.join(" AND ");

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM expenses e WHERE ${where}`,
      values
    );
    const total      = countRes.rows[0].total;
    const totalPages = Math.ceil(total / limit);

    const dataRes = await pool.query(
      `SELECT * FROM expenses e WHERE ${where} ORDER BY ${orderBy} LIMIT $${idx} OFFSET $${idx + 1}`,
      [...values, limit, offset]
    );

    res.json({
      data: dataRes.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── GET SINGLE EXPENSE ───────────────── */

app.get("/expenses/:id", authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      "SELECT * FROM expenses WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.id]
    );
    if (!r.rows.length)
      return res.status(404).json({ error: "Not found" });
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── ADD EXPENSE ───────────────── */

app.post("/add-expense", authenticateToken, async (req, res) => {
  try {
    const { title, amount, category, note } = req.body;

    if (!title || !amount)
      return res.status(400).json({ error: "Title and amount are required" });

    if (isNaN(amount) || Number(amount) <= 0)
      return res.status(400).json({ error: "Amount must be a positive number" });

    const r = await pool.query(
      `INSERT INTO expenses(user_id,title,amount,category,note)
       VALUES($1,$2,$3,$4,$5) RETURNING *`,
      [req.user.id, title, amount, category || "General", note || ""]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── UPDATE EXPENSE ───────────────── */

app.put("/update-expense/:id", authenticateToken, async (req, res) => {
  try {
    const { title, amount, category, note } = req.body;

    if (!title || !amount)
      return res.status(400).json({ error: "Title and amount are required" });

    if (isNaN(amount) || Number(amount) <= 0)
      return res.status(400).json({ error: "Amount must be a positive number" });

    const r = await pool.query(
      `UPDATE expenses
       SET title=$1, amount=$2, category=$3, note=$4
       WHERE id=$5 AND user_id=$6
       RETURNING *`,
      [title, amount, category || "General", note || "", req.params.id, req.user.id]
    );

    if (!r.rows.length)
      return res.status(404).json({ error: "Expense not found" });

    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── DELETE EXPENSE ───────────────── */

app.delete("/delete-expense/:id", authenticateToken, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM expenses WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.id]
    );
    res.json({ message: "Deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── BULK DELETE ───────────────── */

app.post("/bulk-delete", authenticateToken, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length)
      return res.status(400).json({ error: "No ids provided" });

    await pool.query(
      `DELETE FROM expenses WHERE id=ANY($1::int[]) AND user_id=$2`,
      [ids, req.user.id]
    );
    res.json({ message: "Deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── CATEGORIES ───────────────── */

app.get("/categories", authenticateToken, async (req, res) => {
  try {
    let r = await pool.query(
      "SELECT * FROM categories WHERE user_id=$1 ORDER BY name",
      [req.user.id]
    );

    if (!r.rows.length) {
      await pool.query(
        `INSERT INTO categories(user_id,name,color) VALUES
          ($1,'Food','#ff6b6b'),
          ($1,'Travel','#4ecdc4'),
          ($1,'Shopping','#ffe66d'),
          ($1,'Bills','#5f27cd'),
          ($1,'Entertainment','#ff9f43'),
          ($1,'General','#6366f1')`,
        [req.user.id]
      );
      r = await pool.query(
        "SELECT * FROM categories WHERE user_id=$1 ORDER BY name",
        [req.user.id]
      );
    }

    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── ADD CATEGORY ───────────────── */

app.post("/categories", authenticateToken, async (req, res) => {
  try {
    const { name, color } = req.body;
    if (!name)
      return res.status(400).json({ error: "Category name required" });

    const exists = await pool.query(
      "SELECT id FROM categories WHERE user_id=$1 AND name ILIKE $2",
      [req.user.id, name]
    );
    if (exists.rows.length)
      return res.status(400).json({ error: "Category already exists" });

    const r = await pool.query(
      "INSERT INTO categories(user_id,name,color) VALUES($1,$2,$3) RETURNING *",
      [req.user.id, name, color || "#6366f1"]
    );
    res.json(r.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── DELETE CATEGORY ───────────────── */

app.delete("/categories/:id", authenticateToken, async (req, res) => {
  try {
    await pool.query(
      "DELETE FROM categories WHERE id=$1 AND user_id=$2",
      [req.params.id, req.user.id]
    );
    res.json({ message: "Deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── CHART DATA – Daily ───────────────── */

app.get("/chart-data", authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT TO_CHAR(created_at,'YYYY-MM-DD') AS date,
              SUM(amount)::float AS total
       FROM expenses
       WHERE user_id=$1
       GROUP BY date
       ORDER BY date DESC
       LIMIT 30`,
      [req.user.id]
    );
    res.json(r.rows.reverse());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── CHART DATA – Monthly ───────────────── */

app.get("/chart-data/monthly", authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT TO_CHAR(created_at,'YYYY-MM') AS month,
              SUM(amount)::float AS total
       FROM expenses
       WHERE user_id=$1
       GROUP BY month
       ORDER BY month DESC
       LIMIT 12`,
      [req.user.id]
    );
    res.json(r.rows.reverse());
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── CHART DATA – Category ───────────────── */

app.get("/chart-data/category", authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT category,
              SUM(amount)::float AS total
       FROM expenses
       WHERE user_id=$1
       GROUP BY category
       ORDER BY total DESC`,
      [req.user.id]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── DATE FILTER ───────────────── */

app.get("/expenses/filter/date", authenticateToken, async (req, res) => {
  try {
    const { start, end } = req.query;
    const r = await pool.query(
      `SELECT * FROM expenses
       WHERE user_id=$1
         AND created_at >= $2::date
         AND created_at <  ($3::date + INTERVAL '1 day')
       ORDER BY created_at DESC`,
      [req.user.id, start, end]
    );
    res.json(r.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── EXPORT CSV ───────────────── */

app.get("/export/csv", authenticateToken, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT title, amount, category, note,
              TO_CHAR(created_at,'YYYY-MM-DD HH24:MI:SS') AS date
       FROM expenses WHERE user_id=$1 ORDER BY created_at DESC`,
      [req.user.id]
    );

    const rows  = r.rows;
    const header = "Title,Amount,Category,Note,Date\n";
    const csv   = rows.map(row =>
      [row.title, row.amount, row.category, `"${(row.note||"").replace(/"/g,'""')}"`, row.date].join(",")
    ).join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=expenses.csv");
    res.send(header + csv);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/* ───────────────── START ───────────────── */

const PORT = process.env.PORT || 3000;

(async () => {
  await initDB();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`🚀 Running on port ${PORT}`);
  });
})();