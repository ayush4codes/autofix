// ============================================================================
//  AUTOMATA FIX CHALLENGE — server.js
//  Real-time competitive programming event server
//  Stack: Node.js (native http) + Socket.io + Canvas
// ============================================================================

const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("socket.io");
const { createCanvas } = require("canvas");

// ============================================================================
//  CONFIGURATION
// ============================================================================

const PORT = 3000;

const TEST_MODE = false;
const BOOT_TIME = Date.now();
const TEST_START_MS = BOOT_TIME + 5 * 60 * 1000;      // Starts in 5 mins
const TEST_END_MS   = TEST_START_MS + 4 * 60 * 1000;  // 4 min total duration

// Event window: 18:00 IST to 18:30 IST
// IST is UTC+5:30 → offset in ms = 5.5 * 60 * 60 * 1000
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Helper: get current time in IST as a Date-like object
function getNowIST() {
  const now = new Date();
  // Create a date that, when read with getHours/getMinutes, gives IST values
  return new Date(now.getTime() + IST_OFFSET_MS + now.getTimezoneOffset() * 60000);
}

// Build today's event start/end in real UTC timestamps for comparison
function getTodayEventWindow() {
  if (TEST_MODE) {
    return {
      startMs: TEST_START_MS,
      endMs: TEST_END_MS,
      exportMs: TEST_END_MS + 60000,
    };
  }

  const nowIST = getNowIST();
  const year = nowIST.getFullYear();
  const month = nowIST.getMonth();
  const day = nowIST.getDate();

  // 18:00 IST in UTC
  const startIST = new Date(year, month, day, 18, 0, 0, 0);
  const startUTC = new Date(startIST.getTime() - IST_OFFSET_MS - new Date().getTimezoneOffset() * 60000);

  // 19:00 IST in UTC
  const endIST = new Date(year, month, day, 19, 0, 0, 0);
  const endUTC = new Date(endIST.getTime() - IST_OFFSET_MS - new Date().getTimezoneOffset() * 60000);

  // 19:01 IST in UTC (for data export)
  const exportIST = new Date(year, month, day, 19, 1, 0, 0);
  const exportUTC = new Date(exportIST.getTime() - IST_OFFSET_MS - new Date().getTimezoneOffset() * 60000);

  return {
    startMs: startUTC.getTime(),
    endMs: endUTC.getTime(),
    exportMs: exportUTC.getTime(),
  };
}

// Per-user timer duration: 10 minutes
const USER_TIMER_MS = 10 * 60 * 1000;
const EXPLAIN_TIMER_MS = 10 * 60 * 1000;

// ============================================================================
//  IN-MEMORY DATA STORE (no database)
// ============================================================================

// participants = {
//   "DiscordUser#1234": {
//     username: "DiscordUser#1234",
//     startTime: <unix ms>,         // when they clicked Start
//     fixCode: "",                   // their automata fix
//     fixLocked: false,             // true after 15 min or early submit
//     fixLockedAt: <unix ms>,
//     explanation: "",              // logic defense text
//     finalSubmitted: false,        // true after Final Submit
//     finalSubmittedAt: <unix ms>,
//     tabSwitchCount: 0,            // anti-cheat counter
//     disconnects: 0,               // track disconnects
//     socketId: null,               // current socket id
//   }
// }
const participants = {};

// ============================================================================
//  REAL-TIME PERSISTENCE — survive crashes & restarts
// ============================================================================

const BACKUP_PATH = path.join(__dirname, "participants_backup.json");

/**
 * Save the entire participants object to disk.
 * Called on every meaningful data change. Excludes volatile socketId.
 */
function persistToDisk() {
  try {
    const snapshot = {};
    for (const key of Object.keys(participants)) {
      const p = participants[key];
      snapshot[key] = { ...p, socketId: null }; // don't persist socket IDs
    }
    fs.writeFileSync(BACKUP_PATH, JSON.stringify(snapshot, null, 2), "utf-8");
  } catch (err) {
    console.error("[PERSIST] ❌ Failed to write backup:", err.message);
  }
}

/**
 * Load participants from disk backup on server startup.
 * Restores all data except socketId (users must reconnect).
 */
function loadFromDisk() {
  try {
    if (fs.existsSync(BACKUP_PATH)) {
      const raw = fs.readFileSync(BACKUP_PATH, "utf-8");
      const data = JSON.parse(raw);
      for (const key of Object.keys(data)) {
        participants[key] = { ...data[key], socketId: null };
      }
      console.log(`[PERSIST] ✅ Restored ${Object.keys(data).length} participant(s) from backup.`);
    }
  } catch (err) {
    console.error("[PERSIST] ❌ Failed to load backup:", err.message);
  }
}

// Load any existing backup on startup
loadFromDisk();

// ============================================================================
//  AUTOMATA PROBLEM — rendered as a Canvas image
// ============================================================================

// The string permutations problem description
const PROBLEM_LINES = [
  "╔══════════════════════════════════════════════════════════════╗",
  "║            AUTOMATA FIX CHALLENGE — PROBLEM STATEMENT       ║",
  "╠══════════════════════════════════════════════════════════════╣",
  "║                                                              ║",
  "║  The Problem: String Permutations                            ║",
  "║  Objective: You are given a string (passed as an array of    ║",
  "║  characters). You need to use recursion to generate all      ║",
  "║  possible permutations of this string and store them in a    ║",
  "║  result list.                                                ║",
  "║                                                              ║",
  "║  The Issue: The code compiles and runs without crashing.     ║",
  "║  It even returns the correct number of results (N!).         ║",
  "║  However, for the input 'abc', the output contains duplicates║",
  "║  and misses valid permutations (e.g., it might output        ║",
  "║  ['abc', 'acb', 'bac', 'bca', 'cab', 'cba'] incorrectly as   ║",
  "║  ['abc', 'acb', 'bac', 'bca', 'bca', 'bac']).                ║",
  "║                                                              ║",
  "║  YOUR TASK:                                                  ║",
  "║  Find the logical error preventing the correct permutations  ║",
  "║  from forming. Correct the given base code in your chosen    ║",
  "║  language (C++, Python, Java) and submit your fix.           ║",
  "║                                                              ║",
  "║                                                              ║",
  "╚══════════════════════════════════════════════════════════════╝",
];

/**
 * Render the problem statement as a base64-encoded PNG image
 * using the `canvas` package. This prevents simple copy-paste cheating.
 */
function renderProblemImage() {
  const lineHeight = 22;
  const padding = 30;
  const fontSize = 15;

  // Measure canvas size
  const canvasWidth = 720;
  const canvasHeight = PROBLEM_LINES.length * lineHeight + padding * 2;

  const canvas = createCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext("2d");

  // Dark background
  ctx.fillStyle = "#0a0e1a";
  ctx.fillRect(0, 0, canvasWidth, canvasHeight);

  // Subtle border
  ctx.strokeStyle = "#00ff8855";
  ctx.lineWidth = 2;
  ctx.strokeRect(4, 4, canvasWidth - 8, canvasHeight - 8);

  // Monospace font for the problem text
  ctx.font = `${fontSize}px monospace`;
  ctx.fillStyle = "#00ff88";
  ctx.textBaseline = "top";

  // Draw each line
  PROBLEM_LINES.forEach((line, i) => {
    // Highlight bug lines in a warning color
    if (line.includes("BUG")) {
      ctx.fillStyle = "#ff4444";
    } else if (line.includes("YOUR TASK") || line.includes("EXAMPLE FORMAT")) {
      ctx.fillStyle = "#ffcc00";
    } else {
      ctx.fillStyle = "#00ff88";
    }
    ctx.fillText(line, padding, padding + i * lineHeight);
  });

  // Return as base64 data URI
  return canvas.toDataURL("image/png");
}

// Pre-render the problem image once at startup
const PROBLEM_IMAGE_BASE64 = renderProblemImage();
console.log("[SERVER] Problem image rendered (canvas) — base64 ready.");

// ============================================================================
//  HTTP SERVER — serves static files from /public
// ============================================================================

const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  // Default to index.html
  let filePath = req.url === "/" ? "/index.html" : req.url;
  filePath = path.join(__dirname, "public", filePath);

  const ext = path.extname(filePath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": contentType });
    res.end(data);
  });
});

// ============================================================================
//  SOCKET.IO — real-time event management
// ============================================================================

const io = new Server(server, {
  cors: { origin: "*" },
});

/**
 * Determine the current phase of the event based on real time.
 * Returns: "lobby" | "active" | "ended"
 */
function getEventPhase() {
  const now = Date.now();
  const { startMs, endMs } = getTodayEventWindow();

  if (now < startMs) return "lobby";
  if (now >= endMs) return "ended";
  return "active";
}

/**
 * Calculate remaining ms until the event starts (for lobby countdown).
 */
function getMsUntilStart() {
  const { startMs } = getTodayEventWindow();
  return Math.max(0, startMs - Date.now());
}

/**
 * Calculate remaining ms until the event ends (global cutoff).
 */
function getMsUntilEnd() {
  const { endMs } = getTodayEventWindow();
  return Math.max(0, endMs - Date.now());
}

/**
 * Get the remaining ms on a user's personal 10-minute timer.
 * Returns 0 if expired.
 */
function getUserTimeRemaining(username) {
  const p = participants[username];
  if (!p || !p.startTime) return 0;
  const elapsed = Date.now() - p.startTime;
  return Math.max(0, USER_TIMER_MS - elapsed);
}

/**
 * Get the remaining ms on a user's 10-minute explanation timer.
 * Returns 0 if expired.
 */
function getExplainTimeRemaining(username) {
  const p = participants[username];
  if (!p || !p.fixLockedAt) return 0;
  const elapsed = Date.now() - p.fixLockedAt;
  return Math.max(0, EXPLAIN_TIMER_MS - elapsed);
}

/**
 * Check if a user's 10-minute fix window has expired.
 */
function isUserTimerExpired(username) {
  return getUserTimeRemaining(username) <= 0;
}

// ────────────────────────────────────────────────────────────────
//  Socket.io connection handler
// ────────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log(`[SOCKET] Connected: ${socket.id}`);

  // ── 1. Send current event phase to the connecting client ──
  const phase = getEventPhase();
  socket.emit("event:phase", {
    phase,
    msUntilStart: getMsUntilStart(),
    msUntilEnd: getMsUntilEnd(),
    serverTime: Date.now(),
  });

  // ── 2. User Login / Reconnection ──
  socket.on("user:login", (payload, callback) => {
    if (!payload || typeof payload !== "object" || !payload.github) {
      return callback({ ok: false, error: "Invalid payload." });
    }

    const username = payload.github.trim();
    const name = (payload.name || "").trim();
    const language = payload.language || "C++";

    if (username.length < 2 || username.length > 40) {
      return callback({ ok: false, error: "GitHub Username must be 2-40 characters." });
    }

    const phase = getEventPhase();
    if (phase === "lobby") {
      return callback({ ok: false, error: "Event hasn't started yet. Please wait." });
    }
    if (phase === "ended") {
      return callback({ ok: false, error: "Event has ended." });
    }

    // Check if this is a reconnection (user already exists)
    if (participants[username]) {
      const p = participants[username];
      p.socketId = socket.id;
      p.disconnects++;
      console.log(`[RECONNECT] ${username} reconnected (disconnects: ${p.disconnects})`);

      // Send them back their state
      const userTimeRemaining = getUserTimeRemaining(username);
      const fixLocked = p.fixLocked || userTimeRemaining <= 0;

      // If timer expired while disconnected, lock fix
      if (userTimeRemaining <= 0 && !p.fixLocked) {
        p.fixLocked = true;
        p.fixLockedAt = p.startTime + USER_TIMER_MS;
      }

      return callback({
        ok: true,
        reconnected: true,
        data: {
          fixCode: p.fixCode,
          fixLocked: fixLocked,
          explanation: p.explanation,
          finalSubmitted: p.finalSubmitted,
          tabSwitchCount: p.tabSwitchCount,
          timeRemainingMs: fixLocked ? 0 : userTimeRemaining,
          explainTimeRemainingMs: fixLocked ? getExplainTimeRemaining(username) : EXPLAIN_TIMER_MS,
          globalTimeRemainingMs: getMsUntilEnd(),
          problemImage: PROBLEM_IMAGE_BASE64,
          language: p.language,
        },
      });
    }

    // New participant
    participants[username] = {
      username,
      name,
      language,
      startTime: Date.now(),
      fixCode: "",
      fixLocked: false,
      fixLockedAt: null,
      explanation: "",
      finalSubmitted: false,
      finalSubmittedAt: null,
      tabSwitchCount: 0,
      disconnects: 0,
      socketId: socket.id,
    };
    persistToDisk();

    console.log(`[NEW USER] ${username} started at ${new Date().toISOString()}`);

    // Schedule auto-lock for this user after 10 minutes
    const lockDelay = Math.min(USER_TIMER_MS, getMsUntilEnd());
    setTimeout(() => {
      const p = participants[username];
      if (p && !p.fixLocked) {
        p.fixLocked = true;
        p.fixLockedAt = Date.now();
        persistToDisk();
        console.log(`[AUTO-LOCK] ${username}'s fix phase auto-locked.`);
        // Notify the user if they're still connected
        if (p.socketId) {
          io.to(p.socketId).emit("fix:locked", {
            fixCode: p.fixCode,
          });
        }
        
        // Schedule auto-submit for explanation phase after another 10 mins
        const explainLockDelay = Math.min(EXPLAIN_TIMER_MS, getMsUntilEnd());
        setTimeout(() => {
          if (p && !p.finalSubmitted) {
            p.finalSubmitted = true;
            p.finalSubmittedAt = Date.now();
            persistToDisk();
            console.log(`[AUTO-SUBMIT] ${username}'s explanation phase auto-submitted.`);
            if (p.socketId) {
              io.to(p.socketId).emit("explain:locked");
            }
          }
        }, explainLockDelay);
      }
    }, lockDelay);

    callback({
      ok: true,
      reconnected: false,
      data: {
        timeRemainingMs: USER_TIMER_MS,
        explainTimeRemainingMs: EXPLAIN_TIMER_MS,
        globalTimeRemainingMs: getMsUntilEnd(),
        problemImage: PROBLEM_IMAGE_BASE64,
        language: language,
      },
    });
  });

  // ── 3. Periodic fix code auto-save ──
  socket.on("fix:update", ({ username, fixCode }) => {
    const p = participants[username];
    if (!p) return;
    if (p.socketId !== socket.id) return; // Prevent impersonation
    if (p.fixLocked) return; // Can't update after lock
    if (isUserTimerExpired(username)) {
      // Timer expired, lock it
      p.fixLocked = true;
      p.fixLockedAt = Date.now();
      persistToDisk();
      socket.emit("fix:locked", { fixCode: p.fixCode });
      return;
    }
    p.fixCode = fixCode;
    persistToDisk();
  });

  // ── 4. Early submission of fix (before 10 min) ──
  socket.on("fix:submit", ({ username, fixCode }, callback) => {
    const p = participants[username];
    if (!p) return callback({ ok: false, error: "User not found." });
    if (p.socketId !== socket.id) return callback({ ok: false, error: "Unauthorized." });
    if (p.fixLocked) return callback({ ok: false, error: "Already locked." });

    p.fixCode = fixCode;
    p.fixLocked = true;
    p.fixLockedAt = Date.now();
    console.log(`[EARLY SUBMIT] ${username} submitted fix early.`);
    persistToDisk();

    // Schedule auto-submit for explanation phase after another 10 mins
    const explainLockDelay = Math.min(EXPLAIN_TIMER_MS, getMsUntilEnd());
    setTimeout(() => {
      if (p && !p.finalSubmitted) {
        p.finalSubmitted = true;
        p.finalSubmittedAt = Date.now();
        persistToDisk();
        console.log(`[AUTO-SUBMIT] ${username}'s explanation phase auto-submitted.`);
        if (p.socketId) {
          io.to(p.socketId).emit("explain:locked");
        }
      }
    }, explainLockDelay);

    callback({ ok: true });
  });

  // ── 5. Explanation update ──
  socket.on("explanation:update", ({ username, explanation }) => {
    const p = participants[username];
    if (!p) return;
    if (p.socketId !== socket.id) return; // Prevent impersonation
    if (p.finalSubmitted) return; // Can't update after final submit
    p.explanation = explanation;
    persistToDisk();
  });

  // ── 6. Final submission (fix + explanation) ──
  socket.on("final:submit", ({ username, explanation }, callback) => {
    const p = participants[username];
    if (!p) return callback({ ok: false, error: "User not found." });
    if (p.socketId !== socket.id) return callback({ ok: false, error: "Unauthorized." });
    if (p.finalSubmitted) return callback({ ok: false, error: "Already submitted." });

    // Validate word count (50–150 words)
    const wordCount = explanation.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount < 50 || wordCount > 150) {
      return callback({
        ok: false,
        error: `Explanation must be 50-150 words. Current: ${wordCount}.`,
      });
    }

    p.explanation = explanation;
    p.finalSubmitted = true;
    p.finalSubmittedAt = Date.now();
    console.log(`[FINAL SUBMIT] ${username} completed. Words: ${wordCount}`);
    persistToDisk();

    callback({ ok: true });
  });

  // ── 7. Anti-cheat: tab switch tracking ──
  socket.on("anticheat:tabswitch", ({ username }) => {
    const p = participants[username];
    if (!p) return;
    if (p.socketId !== socket.id) return; // Prevent impersonation
    p.tabSwitchCount++;
    persistToDisk();
    console.log(`[ANTI-CHEAT] ${username} switched tabs (count: ${p.tabSwitchCount})`);
    socket.emit("anticheat:warning", {
      tabSwitchCount: p.tabSwitchCount,
      message: `⚠ Tab switch detected! Count: ${p.tabSwitchCount}`,
    });
  });

  // ── 8. Disconnect handling ──
  socket.on("disconnect", () => {
    console.log(`[SOCKET] Disconnected: ${socket.id}`);
    // Find the participant by socketId and nullify it
    for (const key of Object.keys(participants)) {
      if (participants[key].socketId === socket.id) {
        participants[key].socketId = null;
        console.log(`[DISCONNECT] ${key} went offline.`);
        break;
      }
    }
  });
});

// ============================================================================
//  GLOBAL EVENT TIMERS — Broadcast phase changes to ALL clients
// ============================================================================

/**
 * Check every second if the event phase has changed. Broadcast transitions.
 */
let lastPhase = getEventPhase();
setInterval(() => {
  const currentPhase = getEventPhase();

  // Transition: lobby → active
  if (lastPhase === "lobby" && currentPhase === "active") {
    console.log("[EVENT] 🚀 Event window OPEN — 18:00 IST");
    io.emit("event:phase", {
      phase: "active",
      msUntilStart: 0,
      msUntilEnd: getMsUntilEnd(),
      serverTime: Date.now(),
    });
  }

  // Transition: active → ended
  if (lastPhase === "active" && currentPhase === "ended") {
    console.log("[EVENT] 🛑 Event window CLOSED — 19:00 IST");

    // Force-lock all participants
    for (const key of Object.keys(participants)) {
      const p = participants[key];
      if (!p.fixLocked) {
        p.fixLocked = true;
        p.fixLockedAt = Date.now();
      }
      if (!p.finalSubmitted) {
        p.finalSubmitted = true;
        p.finalSubmittedAt = Date.now();
      }
    }
    persistToDisk();

    io.emit("event:ended", {
      message: "⏰ TIME'S UP! The event has ended. All submissions are locked.",
    });

    // Schedule data export at 19:01 IST (1 minute after end)
    setTimeout(() => {
      exportResults();
    }, 60 * 1000);
  }

  lastPhase = currentPhase;
}, 1000);

// ============================================================================
//  DATA EXPORT — Dump all participant data to JSON
// ============================================================================

function exportResults() {
  const outputPath = path.join(__dirname, "event_results.json");
  const exportData = {
    exportedAt: new Date().toISOString(),
    totalParticipants: Object.keys(participants).length,
    participants: Object.values(participants).map((p) => ({
      username: p.username,
      name: p.name,
      language: p.language,
      startTime: p.startTime ? new Date(p.startTime).toISOString() : null,
      fixCode: p.fixCode,
      fixLockedAt: p.fixLockedAt ? new Date(p.fixLockedAt).toISOString() : null,
      explanation: p.explanation,
      finalSubmitted: p.finalSubmitted,
      finalSubmittedAt: p.finalSubmittedAt
        ? new Date(p.finalSubmittedAt).toISOString()
        : null,
      tabSwitchCount: p.tabSwitchCount,
      disconnects: p.disconnects,
    })),
  };

  try {
    fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2), "utf-8");
    console.log(`[EXPORT] ✅ Results written to ${outputPath}`);
  } catch (err) {
    console.error(`[EXPORT] ❌ Failed to write results:`, err);
  }
}

// ============================================================================
//  START SERVER
// ============================================================================

server.listen(PORT, () => {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  AUTOMATA FIX CHALLENGE SERVER`);
  console.log(`  Running on http://localhost:${PORT}`);
  console.log(`  Event Phase: ${getEventPhase().toUpperCase()}`);
  if (TEST_MODE) {
    console.log(`  ⚠️ TEST MODE ACTIVE ⚠️`);
    console.log(`  Starts in 5 minutes. Total window: 4 minutes.`);
  } else {
    console.log(`  Event Window: 18:00 IST — 19:00 IST`);
  }
  console.log(`${"═".repeat(60)}\n`);
});
