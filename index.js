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
   HELPER: Async Error Wrapper
========================= */
const asyncHandler = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};

/* =========================
   INIT TABLE
========================= */
app.get("/init", asyncHandler(async (req, res) => {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS expenses (
            id SERIAL PRIMARY KEY,
            title TEXT NOT NULL,
            amount NUMERIC(12, 2) NOT NULL,
            category TEXT DEFAULT 'General',
            note TEXT,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Categories lookup table
    await pool.query(`
        CREATE TABLE IF NOT EXISTS categories (
            id SERIAL PRIMARY KEY,
            name TEXT UNIQUE NOT NULL,
            color TEXT DEFAULT '#6366f1',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Seed default categories
    await pool.query(`
        INSERT INTO categories (name, color) VALUES
            ('General',     '#6366f1'),
            ('Food',        '#f59e0b'),
            ('Transport',   '#3b82f6'),
            ('Shopping',    '#ec4899'),
            ('Health',      '#10b981'),
            ('Bills',       '#ef4444'),
            ('Entertainment','#8b5cf6'),
            ('Travel',      '#14b8a6')
        ON CONFLICT (name) DO NOTHING
    `);

    res.json({ message: "Tables created & categories seeded ✅" });
}));

/* =========================
   INPUT VALIDATION HELPER
========================= */
function validateExpense(title, amount) {
    const errors = [];
    if (!title || typeof title !== "string" || title.trim() === "") {
        errors.push("Title is required and must be a non-empty string.");
    }
    if (amount === undefined || amount === null || isNaN(Number(amount)) || Number(amount) <= 0) {
        errors.push("Amount must be a positive number.");
    }
    return errors;
}

/* =========================
   ADD EXPENSE
========================= */
app.post("/add-expense", asyncHandler(async (req, res) => {
    const { title, amount, category = "General", note = "" } = req.body;

    const errors = validateExpense(title, amount);
    if (errors.length) return res.status(400).json({ errors });

    const result = await pool.query(
        `INSERT INTO expenses (title, amount, category, note)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [title.trim(), Number(amount), category, note]
    );

    res.status(201).json({ message: "Expense added ✅", expense: result.rows[0] });
}));

/* =========================
   GET ALL EXPENSES (with pagination, search, category filter)
========================= */
app.get("/expenses", asyncHandler(async (req, res) => {
    const {
        page = 1,
        limit = 20,
        search = "",
        category = "",
        sort = "id",
        order = "DESC"
    } = req.query;

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const allowedSort = ["id", "title", "amount", "category", "created_at"];
    const allowedOrder = ["ASC", "DESC"];

    const sortCol = allowedSort.includes(sort) ? sort : "id";
    const sortOrder = allowedOrder.includes(order.toUpperCase()) ? order.toUpperCase() : "DESC";

    const conditions = [];
    const params = [];

    if (search) {
        params.push(`%${search}%`);
        conditions.push(`(title ILIKE $${params.length} OR note ILIKE $${params.length})`);
    }
    if (category) {
        params.push(category);
        conditions.push(`category = $${params.length}`);
    }

    const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";

    const countResult = await pool.query(
        `SELECT COUNT(*) FROM expenses ${where}`, params
    );
    const total = parseInt(countResult.rows[0].count);

    params.push(parseInt(limit), offset);
    const dataResult = await pool.query(
        `SELECT * FROM expenses ${where}
         ORDER BY ${sortCol} ${sortOrder}
         LIMIT $${params.length - 1} OFFSET $${params.length}`,
        params
    );

    res.json({
        data: dataResult.rows,
        pagination: {
            total,
            page: parseInt(page),
            limit: parseInt(limit),
            totalPages: Math.ceil(total / parseInt(limit))
        }
    });
}));

/* =========================
   GET SINGLE EXPENSE
========================= */
app.get("/expenses/:id", asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await pool.query("SELECT * FROM expenses WHERE id = $1", [id]);

    if (!result.rows.length) return res.status(404).json({ error: "Expense not found" });
    res.json(result.rows[0]);
}));

/* =========================
   DELETE EXPENSE
========================= */
app.delete("/delete-expense/:id", asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await pool.query(
        "DELETE FROM expenses WHERE id = $1 RETURNING *", [id]
    );

    if (!result.rows.length) return res.status(404).json({ error: "Expense not found" });
    res.json({ message: "Expense deleted ✅", deleted: result.rows[0] });
}));

/* =========================
   BULK DELETE
========================= */
app.delete("/delete-expenses", asyncHandler(async (req, res) => {
    const { ids } = req.body;

    if (!Array.isArray(ids) || !ids.length) {
        return res.status(400).json({ error: "Provide an array of ids to delete." });
    }

    const placeholders = ids.map((_, i) => `$${i + 1}`).join(", ");
    const result = await pool.query(
        `DELETE FROM expenses WHERE id IN (${placeholders}) RETURNING id`, ids
    );

    res.json({ message: `Deleted ${result.rowCount} expense(s) ✅`, deletedIds: result.rows.map(r => r.id) });
}));

/* =========================
   EDIT EXPENSE
========================= */
app.put("/update-expense/:id", asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { title, amount, category, note } = req.body;

    const errors = validateExpense(title, amount);
    if (errors.length) return res.status(400).json({ errors });

    const result = await pool.query(
        `UPDATE expenses
         SET title=$1, amount=$2, category=$3, note=$4, updated_at=NOW()
         WHERE id=$5
         RETURNING *`,
        [title.trim(), Number(amount), category || "General", note || "", id]
    );

    if (!result.rows.length) return res.status(404).json({ error: "Expense not found" });
    res.json({ message: "Expense updated ✅", expense: result.rows[0] });
}));

/* =========================
   TOTAL AMOUNT
========================= */
app.get("/total", asyncHandler(async (req, res) => {
    const result = await pool.query("SELECT SUM(amount) FROM expenses");
    res.json({ total: parseFloat(result.rows[0].sum) || 0 });
}));

/* =========================
   SUMMARY STATS
========================= */
app.get("/summary", asyncHandler(async (req, res) => {
    const [totals, categoryBreakdown, monthly] = await Promise.all([
        pool.query(`
            SELECT
                COUNT(*)            AS count,
                SUM(amount)         AS total,
                AVG(amount)         AS average,
                MAX(amount)         AS max,
                MIN(amount)         AS min
            FROM expenses
        `),
        pool.query(`
            SELECT category, COUNT(*) AS count, SUM(amount) AS total
            FROM expenses
            GROUP BY category
            ORDER BY total DESC
        `),
        pool.query(`
            SELECT
                TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
                SUM(amount) AS total,
                COUNT(*) AS count
            FROM expenses
            GROUP BY month
            ORDER BY month DESC
            LIMIT 12
        `)
    ]);

    const t = totals.rows[0];
    res.json({
        total:     parseFloat(t.total)   || 0,
        count:     parseInt(t.count)     || 0,
        average:   parseFloat(t.average) || 0,
        max:       parseFloat(t.max)     || 0,
        min:       parseFloat(t.min)     || 0,
        byCategory: categoryBreakdown.rows,
        byMonth:    monthly.rows
    });
}));

/* =========================
   FILTER BY DATE
========================= */
app.get("/expenses-by-date", asyncHandler(async (req, res) => {
    const { start, end } = req.query;

    if (!start || !end) {
        return res.status(400).json({ error: "Provide start and end query params (YYYY-MM-DD)." });
    }

    const result = await pool.query(
        `SELECT * FROM expenses
         WHERE created_at BETWEEN $1 AND $2::date + INTERVAL '1 day'
         ORDER BY created_at DESC`,
        [start, end]
    );

    res.json(result.rows);
}));

/* =========================
   CHART DATA (GROUP BY DATE)
========================= */
app.get("/chart-data", asyncHandler(async (req, res) => {
    const { range = "30" } = req.query;
    const days = Math.min(parseInt(range) || 30, 365);

    const result = await pool.query(
        `SELECT DATE(created_at) AS date, SUM(amount) AS total, COUNT(*) AS count
         FROM expenses
         WHERE created_at >= NOW() - ($1 || ' days')::INTERVAL
         GROUP BY date
         ORDER BY date`,
        [days]
    );

    res.json(result.rows);
}));

/* =========================
   CHART DATA BY CATEGORY (Pie/Doughnut)
========================= */
app.get("/chart-data/category", asyncHandler(async (req, res) => {
    const result = await pool.query(
        `SELECT category, SUM(amount) AS total, COUNT(*) AS count
         FROM expenses
         GROUP BY category
         ORDER BY total DESC`
    );
    res.json(result.rows);
}));

/* =========================
   MONTHLY COMPARISON
========================= */
app.get("/chart-data/monthly", asyncHandler(async (req, res) => {
    const result = await pool.query(
        `SELECT
            TO_CHAR(DATE_TRUNC('month', created_at), 'YYYY-MM') AS month,
            SUM(amount) AS total,
            COUNT(*) AS count
         FROM expenses
         GROUP BY month
         ORDER BY month DESC
         LIMIT 12`
    );
    res.json(result.rows.reverse()); // chronological
}));

/* =========================
   CATEGORIES CRUD
========================= */
app.get("/categories", asyncHandler(async (req, res) => {
    const result = await pool.query("SELECT * FROM categories ORDER BY name ASC");
    res.json(result.rows);
}));

app.post("/categories", asyncHandler(async (req, res) => {
    const { name, color = "#6366f1" } = req.body;
    if (!name) return res.status(400).json({ error: "Category name is required." });

    const result = await pool.query(
        "INSERT INTO categories (name, color) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING RETURNING *",
        [name.trim(), color]
    );

    if (!result.rows.length) return res.status(409).json({ error: "Category already exists." });
    res.status(201).json({ message: "Category created ✅", category: result.rows[0] });
}));

app.delete("/categories/:id", asyncHandler(async (req, res) => {
    const { id } = req.params;
    const result = await pool.query("DELETE FROM categories WHERE id=$1 RETURNING *", [id]);
    if (!result.rows.length) return res.status(404).json({ error: "Category not found." });
    res.json({ message: "Category deleted ✅" });
}));

/* =========================
   RECENT EXPENSES (quick widget)
========================= */
app.get("/recent", asyncHandler(async (req, res) => {
    const { limit = 5 } = req.query;
    const result = await pool.query(
        "SELECT * FROM expenses ORDER BY created_at DESC LIMIT $1",
        [Math.min(parseInt(limit), 50)]
    );
    res.json(result.rows);
}));

/* =========================
   EXPORT AS CSV
========================= */
app.get("/export/csv", asyncHandler(async (req, res) => {
    const result = await pool.query(
        "SELECT id, title, amount, category, note, created_at FROM expenses ORDER BY id DESC"
    );

    const headers = ["id", "title", "amount", "category", "note", "created_at"];
    const rows = result.rows.map(r =>
        headers.map(h => {
            const val = r[h] !== null && r[h] !== undefined ? String(r[h]) : "";
            return `"${val.replace(/"/g, '""')}"`;
        }).join(",")
    );

    const csv = [headers.join(","), ...rows].join("\n");

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="expenses_${Date.now()}.csv"`);
    res.send(csv);
}));

/* =========================
   HEALTH CHECK
========================= */
app.get("/health", asyncHandler(async (req, res) => {
    const db = await pool.query("SELECT NOW()");
    res.json({
        status: "ok",
        uptime: process.uptime(),
        db_time: db.rows[0].now
    });
}));

/* =========================
   ROOT
========================= */
app.get("/", (req, res) => {
    res.json({
        message: "Expense Tracker API 🚀",
        version: "2.0.0",
        endpoints: {
            health:       "GET  /health",
            init:         "GET  /init",
            expenses:     "GET  /expenses?page=1&limit=20&search=&category=&sort=id&order=DESC",
            expense:      "GET  /expenses/:id",
            add:          "POST /add-expense",
            update:       "PUT  /update-expense/:id",
            delete:       "DELETE /delete-expense/:id",
            bulkDelete:   "DELETE /delete-expenses  { ids: [1,2,3] }",
            total:        "GET  /total",
            summary:      "GET  /summary",
            recent:       "GET  /recent?limit=5",
            byDate:       "GET  /expenses-by-date?start=YYYY-MM-DD&end=YYYY-MM-DD",
            chartDaily:   "GET  /chart-data?range=30",
            chartCat:     "GET  /chart-data/category",
            chartMonthly: "GET  /chart-data/monthly",
            categories:   "GET  /categories",
            addCategory:  "POST /categories",
            delCategory:  "DELETE /categories/:id",
            exportCsv:    "GET  /export/csv"
        }
    });
});

/* =========================
   GLOBAL ERROR HANDLER
========================= */
app.use((err, req, res, next) => {
    console.error("❌ Error:", err.message);
    res.status(500).json({ error: "Internal server error", detail: err.message });
});

/* =========================
   SERVER
========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT} 🚀`));