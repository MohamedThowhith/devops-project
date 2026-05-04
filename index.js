const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();
app.use(cors());
app.use(express.json());

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// 🟢 INIT ROUTE (create table)
app.get("/init", async (req, res) => {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS expenses (
                id SERIAL PRIMARY KEY,
                title TEXT,
                amount INT
            )
        `);
        res.send("Table created");
    } catch (err) {
        console.error(err);
        res.status(500).send("Error creating table");
    }
});

// 🟢 ADD EXPENSE
app.post("/add-expense", async (req, res) => {
    try {
        const { title, amount } = req.body;
        await pool.query(
            "INSERT INTO expenses (title, amount) VALUES ($1, $2)",
            [title, amount]
        );
        res.send("Expense added");
    } catch (err) {
        console.error(err);
        res.status(500).send("Error adding expense");
    }
});

// 🟢 GET ALL EXPENSES
app.get("/expenses", async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT * FROM expenses ORDER BY id DESC"
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).send("Error fetching expenses");
    }
});

// Basic routes
app.get("/", (req, res) => {
    res.send("DevOps Expense Tracker Running 🚀");
});

app.get("/health", (req, res) => {
    res.json({ status: "OK" });
});

// Start server
app.listen(3000, () => {
    console.log("Server running on port 3000");
});