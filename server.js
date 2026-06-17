// ============================================================================
//  AUTOMATA FIX CHALLENGE — server.js (Local Launcher)
//  Launches the serverless Express application for local development
// ============================================================================

require("dotenv").config();
const app = require("./api/server.js");
const express = require("express");
const path = require("path");

const PORT = 3000;

// Serve static assets from /public (e.g. index.html)
app.use(express.static(path.join(__dirname, "public")));

// Serve index.html as a fallback for any non-API routes
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return next();
  }
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AUTOMATA FIX CHALLENGE SERVER (LOCAL DEV MODE)`);
  console.log(`  Running on http://localhost:${PORT}`);
  console.log(`  Verify API results at http://localhost:${PORT}/api/results`);
  console.log(`${"═".repeat(60)}\n`);
});
