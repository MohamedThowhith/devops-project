const express = require("express");
const cors = require("cors");

const app = express();

// Enable CORS (IMPORTANT for frontend connection)
app.use(cors());

// Routes
app.get("/", (req, res) => {
    res.send("DevOps Project Running 🚀");
});

app.get("/health", (req, res) => {
    res.json({ status: "OK" });
});

// Start server
app.listen(3000, () => {
    console.log("Server running on port 3000");
});