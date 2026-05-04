const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

// Use Render environment variable
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Create table
app.get("/init", async (req, res) => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS expenses (
            id SERIAL PRIMARY KEY,
            title TEXT,
            amount INT
        )
    `);
    res.send("Table created");
});

// Add expense
app.post("/add-expense", async (req, res) => {
    const { title, amount } = req.body;
    await pool.query(
        "INSERT INTO expenses (title, amount) VALUES ($1, $2)",
        [title, amount]
    );
    res.send("Expense added");
});

// Get all expenses
app.get("/expenses", async (req, res) => {
    const result = await pool.query("SELECT * FROM expenses ORDER BY id DESC");
    res.json(result.rows);
});

app.listen(3000, () => {
    console.log("Server running on port 3000");
});