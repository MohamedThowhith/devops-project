const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// ✅ Test DB
pool.connect()
    .then(() => console.log("DB Connected ✅"))
    .catch(err => console.error("DB Error ❌", err));

/* =========================
   INIT TABLE
========================= */
app.get("/init", async (req, res) => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS expenses (
            id SERIAL PRIMARY KEY,
            title TEXT,
            amount INT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);
    res.send("Table created");
});

/* =========================
   ADD EXPENSE
========================= */
app.post("/add-expense", async (req, res) => {
    const { title, amount } = req.body;

    await pool.query(
        "INSERT INTO expenses (title, amount) VALUES ($1, $2)",
        [title, amount]
    );

    res.send("Expense added");
});

/* =========================
   GET ALL EXPENSES
========================= */
app.get("/expenses", async (req, res) => {
    const result = await pool.query(
        "SELECT * FROM expenses ORDER BY id DESC"
    );
    res.json(result.rows);
});

/* =========================
   DELETE EXPENSE
========================= */
app.delete("/delete-expense/:id", async (req, res) => {
    const { id } = req.params;

    await pool.query(
        "DELETE FROM expenses WHERE id = $1",
        [id]
    );

    res.send("Expense deleted");
});

/* =========================
   EDIT EXPENSE
========================= */
app.put("/update-expense/:id", async (req, res) => {
    const { id } = req.params;
    const { title, amount } = req.body;

    await pool.query(
        "UPDATE expenses SET title=$1, amount=$2 WHERE id=$3",
        [title, amount, id]
    );

    res.send("Expense updated");
});

/* =========================
   TOTAL AMOUNT
========================= */
app.get("/total", async (req, res) => {
    const result = await pool.query(
        "SELECT SUM(amount) FROM expenses"
    );

    res.json({ total: result.rows[0].sum || 0 });
});

/* =========================
   FILTER BY DATE
========================= */
app.get("/expenses-by-date", async (req, res) => {
    const { start, end } = req.query;

    const result = await pool.query(
        `SELECT * FROM expenses 
         WHERE created_at BETWEEN $1 AND $2 
         ORDER BY created_at DESC`,
        [start, end]
    );

    res.json(result.rows);
});

/* =========================
   CHART DATA (GROUP BY DATE)
========================= */
app.get("/chart-data", async (req, res) => {
    const result = await pool.query(
        `SELECT DATE(created_at) as date, SUM(amount) as total
         FROM expenses
         GROUP BY date
         ORDER BY date`
    );

    res.json(result.rows);
});

/* =========================
   ROOT
========================= */
app.get("/", (req, res) => {
    res.send("Expense Tracker API Running 🚀");
});

/* =========================
   SERVER
========================= */
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});