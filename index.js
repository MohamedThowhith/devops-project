const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   DATABASE
========================= */
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect()
    .then(() => console.log("DB Connected ✅"))
    .catch(err => console.error("DB Error ❌", err));

/* =========================
   ASYNC WRAPPER
========================= */
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

/* =========================
   INIT TABLES
========================= */
app.get("/init", asyncHandler(async (req, res) => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS expenses (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            amount NUMERIC(12,2) NOT NULL,
            category TEXT DEFAULT 'General',
            note TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS categories (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            color TEXT DEFAULT '#6366f1'
        )
    `);

    await pool.query(`
        INSERT INTO categories (name, color) VALUES
        ('General','#6366f1'),
        ('Food','#f59e0b'),
        ('Transport','#3b82f6')
        ON CONFLICT (name) DO NOTHING
    `);

    res.json({ message: "Initialized ✅" });
}));

/* =========================
   VALIDATION
========================= */
function validateExpense(title, amount) {
    const errors = [];

    if (!title || typeof title !== "string" || !title.trim()) {
        errors.push("Title is required");
    }

    const parsed = parseFloat(amount);
    if (isNaN(parsed) || parsed <= 0) {
        errors.push("Amount must be a valid positive number");
    }

    return { errors, parsedAmount: parsed };
}

/* =========================
   ADD EXPENSE (FIXED)
========================= */
app.post("/add-expense", asyncHandler(async (req, res) => {
    console.log("Incoming:", req.body);

    const { title, amount, category, note } = req.body;

    const { errors, parsedAmount } = validateExpense(title, amount);
    if (errors.length) {
        return res.status(400).json({ errors });
    }

    const safeCategory = category || "General";
    const safeNote = note || "";

    const result = await pool.query(
        `INSERT INTO expenses (title, amount, category, note)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [title.trim(), parsedAmount, safeCategory, safeNote]
    );

    res.status(201).json({
        message: "Expense added ✅",
        expense: result.rows[0]
    });
}));

/* =========================
   GET EXPENSES
========================= */
app.get("/expenses", asyncHandler(async (req, res) => {
    const { page = 1, limit = 20 } = req.query;
    const offset = (page - 1) * limit;

    const totalRes = await pool.query("SELECT COUNT(*) FROM expenses");
    const total = parseInt(totalRes.rows[0].count);

    const dataRes = await pool.query(
        `SELECT * FROM expenses
         ORDER BY id DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
    );

    res.json({
        data: dataRes.rows,
        pagination: {
            total,
            page: parseInt(page),
            limit: parseInt(limit),
            totalPages: Math.ceil(total / limit)
        }
    });
}));

/* =========================
   GET SINGLE
========================= */
app.get("/expenses/:id", asyncHandler(async (req, res) => {
    const result = await pool.query(
        "SELECT * FROM expenses WHERE id=$1",
        [req.params.id]
    );

    if (!result.rows.length) {
        return res.status(404).json({ error: "Not found" });
    }

    res.json(result.rows[0]);
}));

/* =========================
   UPDATE EXPENSE (FIXED)
========================= */
app.put("/update-expense/:id", asyncHandler(async (req, res) => {
    const { title, amount, category, note } = req.body;

    const { errors, parsedAmount } = validateExpense(title, amount);
    if (errors.length) {
        return res.status(400).json({ errors });
    }

    const result = await pool.query(
        `UPDATE expenses
         SET title=$1, amount=$2, category=$3, note=$4, updated_at=NOW()
         WHERE id=$5
         RETURNING *`,
        [
            title.trim(),
            parsedAmount,
            category || "General",
            note || "",
            req.params.id
        ]
    );

    if (!result.rows.length) {
        return res.status(404).json({ error: "Not found" });
    }

    res.json({
        message: "Updated ✅",
        expense: result.rows[0]
    });
}));

/* =========================
   DELETE
========================= */
app.delete("/delete-expense/:id", asyncHandler(async (req, res) => {
    const result = await pool.query(
        "DELETE FROM expenses WHERE id=$1 RETURNING *",
        [req.params.id]
    );

    if (!result.rows.length) {
        return res.status(404).json({ error: "Not found" });
    }

    res.json({ message: "Deleted ✅" });
}));

/* =========================
   SUMMARY
========================= */
app.get("/summary", asyncHandler(async (req, res) => {
    const result = await pool.query(`
        SELECT 
            COUNT(*) as count,
            SUM(amount) as total,
            AVG(amount) as average,
            MAX(amount) as max,
            MIN(amount) as min
        FROM expenses
    `);

    const r = result.rows[0];

    res.json({
        total: parseFloat(r.total) || 0,
        count: parseInt(r.count),
        average: parseFloat(r.average) || 0,
        max: parseFloat(r.max) || 0,
        min: parseFloat(r.min) || 0
    });
}));

/* =========================
   CATEGORIES
========================= */
app.get("/categories", asyncHandler(async (req, res) => {
    const result = await pool.query("SELECT * FROM categories");
    res.json(result.rows);
}));

app.post("/categories", asyncHandler(async (req, res) => {
    const { name, color } = req.body;

    if (!name) {
        return res.status(400).json({ error: "Name required" });
    }

    const result = await pool.query(
        `INSERT INTO categories (name, color)
         VALUES ($1,$2)
         ON CONFLICT(name) DO NOTHING
         RETURNING *`,
        [name.trim(), color || "#6366f1"]
    );

    if (!result.rows.length) {
        return res.status(409).json({ error: "Exists" });
    }

    res.json(result.rows[0]);
}));

app.delete("/categories/:id", asyncHandler(async (req, res) => {
    await pool.query("DELETE FROM categories WHERE id=$1", [req.params.id]);
    res.json({ message: "Deleted" });
}));

/* =========================
   ERROR HANDLER
========================= */
app.use((err, req, res, next) => {
    console.error("ERROR:", err);
    res.status(500).json({
        error: err.message || "Internal Server Error"
    });
});

/* =========================
   SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("Server running 🚀"));