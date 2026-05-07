const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const { Parser } = require("json2csv");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

require("dotenv").config();

const app = express();

app.use(cors());
app.use(express.json());

/* ───────────────── DATABASE ───────────────── */

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL
    ? { rejectUnauthorized: false }
    : false,
});

/* ───────────────── ROOT ───────────────── */

app.get("/", (req, res) => {
  res.send("🚀 Expense Tracker API Running");
});

app.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

/* ───────────────── JWT AUTH ───────────────── */

function auth(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      error: "Unauthorized",
    });
  }

  try {
    const decoded = jwt.verify(
      token,
      process.env.JWT_SECRET
    );

    req.user = decoded;

    next();
  } catch {
    return res.status(401).json({
      error: "Invalid token",
    });
  }
}

/* ───────────────── INIT DB ───────────────── */

async function initDB() {
  try {
    console.log("🔄 Connecting DB...");

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
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        color TEXT DEFAULT '#6366f1'
      )
    `);

    /* EXPENSES */
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
  } catch (err) {
    console.error("DB INIT ERROR:", err);
    throw err;
  }
}

/* ───────────────── REGISTER ───────────────── */

app.post("/register", async (req, res) => {
  try {
    const { name, email, password } = req.body;

    const exists = await pool.query(
      "SELECT * FROM users WHERE email=$1",
      [email]
    );

    if (exists.rows.length) {
      return res.status(400).json({
        error: "Email already exists",
      });
    }

    const hashed = await bcrypt.hash(password, 10);

    const user = await pool.query(
      `
      INSERT INTO users(name,email,password)
      VALUES($1,$2,$3)
      RETURNING id,name,email
      `,
      [name, email, hashed]
    );

    const token = jwt.sign(
      { id: user.rows[0].id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({
      token,
      user: user.rows[0],
    });

  } catch (err) {
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
        error: "Invalid credentials",
      });
    }

    const valid = await bcrypt.compare(
      password,
      user.rows[0].password
    );

    if (!valid) {
      return res.status(400).json({
        error: "Invalid credentials",
      });
    }

    const token = jwt.sign(
      { id: user.rows[0].id },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
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
    res.status(500).json({
      error: err.message,
    });
  }
});

/* ───────────────── SUMMARY ───────────────── */

app.get("/summary", auth, async (req, res) => {
  try {
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

  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

/* ───────────────── GET EXPENSES ───────────────── */

app.get("/expenses", auth, async (req, res) => {
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

    let values = [req.user.id];
    let where = ["user_id=$1"];

    if (search) {
      values.push(`%${search}%`);

      where.push(
        `(title ILIKE $${values.length} OR note ILIKE $${values.length})`
      );
    }

    if (category) {
      values.push(category);

      where.push(`category=$${values.length}`);
    }

    const whereClause = `WHERE ${where.join(" AND ")}`;

    const data = await pool.query(
      `
      SELECT *
      FROM expenses
      ${whereClause}
      ORDER BY ${sortColumn} ${order}
      LIMIT $${values.length + 1}
      OFFSET $${values.length + 2}
      `,
      [...values, limit, offset]
    );

    const count = await pool.query(
      `
      SELECT COUNT(*)
      FROM expenses
      ${whereClause}
      `,
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
    res.status(500).json({
      error: err.message,
    });
  }
});

/* ───────────────── SINGLE EXPENSE ───────────────── */

app.get("/expenses/:id", auth, async (req, res) => {
  try {
    const r = await pool.query(
      `
      SELECT *
      FROM expenses
      WHERE id=$1 AND user_id=$2
      `,
      [req.params.id, req.user.id]
    );

    if (!r.rows.length) {
      return res.status(404).json({
        error: "Expense not found",
      });
    }

    res.json(r.rows[0]);

  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

/* ───────────────── ADD EXPENSE ───────────────── */

app.post("/add-expense", auth, async (req, res) => {
  try {
    const { title, amount, category, note } = req.body;

    if (!title || amount == null) {
      return res.status(400).json({
        error: "Title and amount required",
      });
    }

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
    res.status(500).json({
      error: err.message,
    });
  }
});

/* ───────────────── UPDATE EXPENSE ───────────────── */

app.put("/update-expense/:id", auth, async (req, res) => {
  try {
    const { title, amount, category, note } = req.body;

    const r = await pool.query(
      `
      UPDATE expenses
      SET
        title=$1,
        amount=$2,
        category=$3,
        note=$4
      WHERE id=$5
      AND user_id=$6
      RETURNING *
      `,
      [
        title,
        amount,
        category,
        note,
        req.params.id,
        req.user.id,
      ]
    );

    if (!r.rows.length) {
      return res.status(404).json({
        error: "Expense not found",
      });
    }

    res.json(r.rows[0]);

  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

/* ───────────────── DELETE EXPENSE ───────────────── */

app.delete("/delete-expense/:id", auth, async (req, res) => {
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

/* ───────────────── BULK DELETE ───────────────── */

app.delete("/delete-expenses", auth, async (req, res) => {
  try {
    const { ids } = req.body;

    await pool.query(
      `
      DELETE FROM expenses
      WHERE id = ANY($1::int[])
      AND user_id=$2
      `,
      [ids, req.user.id]
    );

    res.json({
      message: "Deleted selected",
    });

  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

/* ───────────────── CATEGORIES ───────────────── */

app.get("/categories", auth, async (req, res) => {
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
});

app.post("/categories", auth, async (req, res) => {
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

  } catch {
    res.status(400).json({
      error: "Category exists",
    });
  }
});

app.delete("/categories/:id", auth, async (req, res) => {
  await pool.query(
    `
    DELETE FROM categories
    WHERE id=$1
    AND user_id=$2
    `,
    [req.params.id, req.user.id]
  );

  res.json({
    message: "Deleted",
  });
});

/* ───────────────── DATE FILTER ───────────────── */

app.get("/expenses-by-date", auth, async (req, res) => {
  try {
    const { start, end } = req.query;

    const r = await pool.query(
      `
      SELECT *
      FROM expenses
      WHERE user_id=$1
      AND created_at::date BETWEEN $2 AND $3
      ORDER BY created_at DESC
      `,
      [req.user.id, start, end]
    );

    res.json(r.rows);

  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

/* ───────────────── CHARTS ───────────────── */

app.get("/chart-data", auth, async (req, res) => {
  try {
    const range = Number(req.query.range || 30);

    const r = await pool.query(
      `
      SELECT
        TO_CHAR(created_at,'DD Mon') AS date,
        SUM(amount)::numeric AS total
      FROM expenses
      WHERE user_id=$1
      AND created_at >= NOW() - ($2 || ' days')::interval
      GROUP BY DATE(created_at), TO_CHAR(created_at,'DD Mon')
      ORDER BY DATE(created_at)
      `,
      [req.user.id, range]
    );

    res.json(r.rows);

  } catch (err) {
    res.status(500).json({
      error: err.message,
    });
  }
});

app.get("/chart-data/monthly", auth, async (req, res) => {
  try {
    const r = await pool.query(
      `
      SELECT
        TO_CHAR(created_at,'Mon YYYY') AS month,
        SUM(amount)::numeric AS total
      FROM expenses
      WHERE user_id=$1
      GROUP BY DATE_TRUNC('month', created_at),
               TO_CHAR(created_at,'Mon YYYY')
      ORDER BY DATE_TRUNC('month', created_at)
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

app.get("/chart-data/category", auth, async (req, res) => {
  try {
    const r = await pool.query(
      `
      SELECT
        category,
        SUM(amount)::numeric AS total
      FROM expenses
      WHERE user_id=$1
      GROUP BY category
      ORDER BY total DESC
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

/* ───────────────── EXPORT CSV ───────────────── */

app.get("/export/csv", auth, async (req, res) => {
  try {
    const r = await pool.query(
      `
      SELECT
        id,
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

  } catch {
    res.status(500).send("Export failed");
  }
});

/* ───────────────── SERVER ───────────────── */

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