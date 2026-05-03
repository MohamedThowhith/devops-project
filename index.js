const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(cors());
app.use(express.json());

const JWT_SECRET = process.env.JWT_SECRET || "devops_secret_key";

// ── In-memory stores ──────────────────────────────────────
let users = [];
let deployments = [];
let alerts = [];

// ── Auth Middleware ───────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  if (!token) return res.status(401).json({ error: "No token provided" });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
}

// ── WebSocket helpers ─────────────────────────────────────
function broadcastLog(deploymentId, message) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: "log", deploymentId, message,
        timestamp: new Date().toISOString()
      }));
    }
  });
}

function broadcastAlert(alert) {
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: "alert", alert }));
    }
  });
}

wss.on("connection", (ws) => {
  ws.send(JSON.stringify({ type: "connected", message: "WebSocket connected!" }));
});

// ── AUTH ROUTES ───────────────────────────────────────────

app.post("/auth/register", async (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password)
    return res.status(400).json({ error: "Name, email and password required" });
  if (users.find((u) => u.email === email))
    return res.status(409).json({ error: "Email already registered" });

  const hashed = await bcrypt.hash(password, 10);
  const user = { id: uuidv4(), name, email, password: hashed, createdAt: new Date().toISOString() };
  users.push(user);
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "7d" });
  res.status(201).json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  const user = users.find((u) => u.email === email);
  if (!user) return res.status(401).json({ error: "Invalid credentials" });
  const valid = await bcrypt.compare(password, user.password);
  if (!valid) return res.status(401).json({ error: "Invalid credentials" });
  const token = jwt.sign({ id: user.id, email: user.email, name: user.name }, JWT_SECRET, { expiresIn: "7d" });
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

app.get("/auth/me", authMiddleware, (req, res) => {
  const user = users.find((u) => u.id === req.user.id);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ id: user.id, name: user.name, email: user.email });
});

// ── DEPLOYMENT ROUTES ─────────────────────────────────────

app.get("/deployments", authMiddleware, (req, res) => {
  res.json(deployments.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)));
});

app.post("/deployments", authMiddleware, (req, res) => {
  const { name, environment, branch } = req.body;
  if (!name || !environment)
    return res.status(400).json({ error: "Name and environment required" });

  const deployment = {
    id: uuidv4(), name, environment,
    branch: branch || "main",
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null, duration: null,
    logs: [], triggeredBy: req.user.email,
  };
  deployments.push(deployment);

  const logSteps = [
    `🔗 Connecting to ${environment} server...`,
    `📦 Cloning branch '${deployment.branch}'...`,
    `📥 Installing dependencies...`,
    `🔨 Running build process...`,
    `🧪 Running tests...`,
    `🚀 Deploying to ${environment}...`,
    `✅ Deployment complete!`,
  ];

  let step = 0;
  const interval = setInterval(() => {
    if (step < logSteps.length) {
      const logMsg = logSteps[step];
      deployment.logs.push({ message: logMsg, timestamp: new Date().toISOString() });
      broadcastLog(deployment.id, logMsg);
      step++;
    } else {
      clearInterval(interval);
      const success = Math.random() > 0.2;
      deployment.status = success ? "success" : "failed";
      deployment.finishedAt = new Date().toISOString();
      deployment.duration = Math.floor(
        (new Date(deployment.finishedAt) - new Date(deployment.startedAt)) / 1000
      );
      broadcastLog(deployment.id, success ? "🎉 Build succeeded!" : "❌ Build failed!");

      if (!success) {
        const alert = {
          id: uuidv4(), type: "failure",
          message: `Deployment '${deployment.name}' failed on ${deployment.environment}`,
          deploymentId: deployment.id,
          createdAt: new Date().toISOString(), read: false,
        };
        alerts.push(alert);
        broadcastAlert(alert);
      }

      wss.clients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(JSON.stringify({
            type: "status_update",
            deploymentId: deployment.id,
            status: deployment.status
          }));
        }
      });
    }
  }, 1200);

  res.status(201).json(deployment);
});

app.get("/deployments/:id", authMiddleware, (req, res) => {
  const dep = deployments.find((d) => d.id === req.params.id);
  if (!dep) return res.status(404).json({ error: "Deployment not found" });
  res.json(dep);
});

app.patch("/deployments/:id/status", authMiddleware, (req, res) => {
  const dep = deployments.find((d) => d.id === req.params.id);
  if (!dep) return res.status(404).json({ error: "Deployment not found" });
  const { status } = req.body;
  if (!["running", "success", "failed", "cancelled"].includes(status))
    return res.status(400).json({ error: "Invalid status" });
  dep.status = status;
  dep.finishedAt = new Date().toISOString();
  res.json(dep);
});

app.delete("/deployments/:id", authMiddleware, (req, res) => {
  const idx = deployments.findIndex((d) => d.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Deployment not found" });
  deployments.splice(idx, 1);
  res.json({ message: "Deployment deleted" });
});

// ── METRICS ROUTE ─────────────────────────────────────────

app.get("/metrics", authMiddleware, (req, res) => {
  const total   = deployments.length;
  const success = deployments.filter((d) => d.status === "success").length;
  const failed  = deployments.filter((d) => d.status === "failed").length;
  const running = deployments.filter((d) => d.status === "running").length;
  const successRate = total > 0 ? Math.round((success / (total - running)) * 100) || 0 : 0;
  const durations = deployments.filter((d) => d.duration).map((d) => d.duration);
  const avgDuration = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;
  const recent = deployments.slice(-7).map((d) => ({
    name: d.name, status: d.status, duration: d.duration, date: d.startedAt
  }));
  res.json({ total, success, failed, running, successRate, avgDuration, recent });
});

// ── ALERTS ROUTES ─────────────────────────────────────────

app.get("/alerts", authMiddleware, (req, res) => {
  res.json(alerts.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.patch("/alerts/:id/read", authMiddleware, (req, res) => {
  const alert = alerts.find((a) => a.id === req.params.id);
  if (!alert) return res.status(404).json({ error: "Alert not found" });
  alert.read = true;
  res.json(alert);
});

app.delete("/alerts/:id", authMiddleware, (req, res) => {
  const idx = alerts.findIndex((a) => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: "Alert not found" });
  alerts.splice(idx, 1);
  res.json({ message: "Alert dismissed" });
});

// ── ORIGINAL ROUTES (kept) ────────────────────────────────

app.get("/", (req, res) => {
  res.json({ message: "DevOps Project Running 🚀" });
});

app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    uptime: process.uptime(),
    deployments: deployments.length,
    users: users.length
  });
});

// ── START SERVER ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});