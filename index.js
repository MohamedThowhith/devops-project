const express = require("express");
const cors = require("cors");
require("dotenv").config();
const { Pool } = require("pg");

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

// Initialize DB (skip during CI if needed)
const initDB = async () => {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS expenses (
        id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        amount NUMERIC NOT NULL,
        category TEXT,
        date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log("Database initialized");
  } catch (err) {
    console.error("DB Init Error:", err.message);
  }
};

// Only run DB init when not in test
if (process.env.NODE_ENV !== "test") {
  initDB();
}

// ✅ Health check (IMPORTANT for CI/CD)
app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK" });
});

// Default route
app.get("/", (req, res) => {
  res.send("Expense Tracker API running (PostgreSQL)");
});

// Get all expenses
app.get("/api/expenses", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM expenses ORDER BY date DESC"
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Add expense
app.post("/api/expenses", async (req, res) => {
  const { title, amount, category } = req.body;

  if (!title || !amount) {
    return res.status(400).json({
      error: "Title and amount are required",
    });
  }

  try {
    const result = await pool.query(
      "INSERT INTO expenses (title, amount, category) VALUES ($1, $2, $3) RETURNING *",
      [title, amount, category]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update expense
app.put("/api/expenses/:id", async (req, res) => {
  const { title, amount, category } = req.body;

  try {
    const result = await pool.query(
      `UPDATE expenses
       SET title=$1, amount=$2, category=$3
       WHERE id=$4
       RETURNING *`,
      [title, amount, category, req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Expense not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete expense
app.delete("/api/expenses/:id", async (req, res) => {
  try {
    const result = await pool.query(
      "DELETE FROM expenses WHERE id=$1 RETURNING *",
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Expense not found" });
    }

    res.json({ message: "Deleted successfully" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Server
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});