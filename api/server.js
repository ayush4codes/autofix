// ============================================================================
//  AUTOMATA FIX CHALLENGE — api/server.js
//  Serverless-friendly Express API for Vercel & MongoDB
// ============================================================================

const express = require("express");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

const app = express();
app.use(express.json());

// Enable CORS for testing
app.use((req, res, next) => {
  // In production (Vercel), frontend and API share the same origin — CORS not needed.
  // Only enable permissive CORS for local development.
  if (!process.env.VERCEL) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      return res.sendStatus(200);
    }
  }
  next();
});

// ============================================================================
//  CONFIGURATION
// ============================================================================

const TEST_MODE = false;
const USER_TIMER_MS = 15 * 60 * 1000;      // 15 minutes for fix phase
const EXPLAIN_TIMER_MS = 10 * 60 * 1000;   // 10 minutes for explanation phase
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

// Helper: get current time in IST as a Date-like object
function getNowIST() {
  const now = new Date();
  return new Date(now.getTime() + IST_OFFSET_MS + now.getTimezoneOffset() * 60000);
}

// ============================================================================
//  UNIFIED STORAGE MANAGER (MongoDB -> Vercel KV -> Local JSON Backup)
// ============================================================================

let cachedDb = null;

async function getMongoDb() {
  if (cachedDb) return cachedDb;
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db("automata_challenge");
  cachedDb = db;
  return db;
}

class StorageManager {
  constructor() {
    this.isMongo = !!process.env.MONGODB_URI;
    
    if (!this.isMongo) {
      // Local fallback configuration (root folder relative)
      this.backupPath = path.join(process.cwd(), "participants_backup.json");
      this.participants = {};
      this.eventWindow = null;
      this.loadLocal();
    }
  }

  loadLocal() {
    try {
      if (fs.existsSync(this.backupPath)) {
        const raw = fs.readFileSync(this.backupPath, "utf-8");
        const data = JSON.parse(raw);
        this.participants = data.participants || {};
        this.eventWindow = data.eventWindow || null;
        console.log(`[STORAGE] Loaded ${Object.keys(this.participants).length} participants from local disk.`);
      }
    } catch (e) {
      console.warn("[STORAGE] Failed to load local backup:", e.message);
    }
  }

  saveLocal() {
    try {
      fs.writeFileSync(
        this.backupPath,
        JSON.stringify({ participants: this.participants, eventWindow: this.eventWindow }, null, 2),
        "utf-8"
      );
    } catch (e) {
      console.error("[STORAGE] Failed to write local backup:", e.message);
    }
  }

  async getParticipant(username) {
    if (this.isMongo) {
      const db = await getMongoDb();
      return await db.collection("participants").findOne({ username });
    }
    return this.participants[username] || null;
  }

  async setParticipant(username, data) {
    // Strip unstable properties like socketId
    const cleanData = { ...data, socketId: null };

    if (this.isMongo) {
      const db = await getMongoDb();
      await db.collection("participants").updateOne(
        { username },
        { $set: cleanData },
        { upsert: true }
      );
      return;
    }
    this.participants[username] = cleanData;
    this.saveLocal();
  }

  async getAllParticipants() {
    if (this.isMongo) {
      const db = await getMongoDb();
      return await db.collection("participants").find({}).toArray();
    }
    return Object.values(this.participants);
  }

  async getEventWindow() {
    if (this.isMongo) {
      const db = await getMongoDb();
      const doc = await db.collection("config").findOne({ key: "event_window" });
      return doc ? doc.value : null;
    }
    return this.eventWindow;
  }

  async setEventWindow(windowData) {
    if (this.isMongo) {
      const db = await getMongoDb();
      await db.collection("config").updateOne(
        { key: "event_window" },
        { $set: { value: windowData } },
        { upsert: true }
      );
      return;
    }
    this.eventWindow = windowData;
    this.saveLocal();
  }
}

const storage = new StorageManager();

// ============================================================================
//  EVENT WINDOW CALCULATION
// ============================================================================

async function getTodayEventWindow() {
  if (TEST_MODE) {
    let windowData = await storage.getEventWindow();
    if (!windowData) {
      const now = Date.now();
      windowData = {
        startMs: now + 5 * 60 * 1000,       // Starts in 5 minutes
        endMs: now + 9 * 60 * 1000,         // 4 minutes total duration
        exportMs: now + 10 * 60 * 1000,     // 1 minute buffer for export
      };
      await storage.setEventWindow(windowData);
    }
    return windowData;
  }

  const nowIST = getNowIST();
  const year = nowIST.getFullYear();
  const month = nowIST.getMonth();
  const day = nowIST.getDate();

  // 16:00 IST in UTC
  const startIST = new Date(year, month, day, 16, 0, 0, 0);
  const startUTC = new Date(startIST.getTime() - IST_OFFSET_MS - new Date().getTimezoneOffset() * 60000);

  // 17:00 IST in UTC
  const endIST = new Date(year, month, day, 17, 0, 0, 0);
  const endUTC = new Date(endIST.getTime() - IST_OFFSET_MS - new Date().getTimezoneOffset() * 60000);

  // 17:01 IST in UTC (for data export)
  const exportIST = new Date(year, month, day, 17, 1, 0, 0);
  const exportUTC = new Date(exportIST.getTime() - IST_OFFSET_MS - new Date().getTimezoneOffset() * 60000);

  return {
    startMs: startUTC.getTime(),
    endMs: endUTC.getTime(),
    exportMs: exportUTC.getTime(),
  };
}

async function getEventPhase() {
  const now = Date.now();
  const { startMs, endMs } = await getTodayEventWindow();

  if (now < startMs) return "lobby";
  if (now >= endMs) return "ended";
  return "active";
}

// ============================================================================
//  API ENDPOINTS
// ============================================================================

// 1. Get Event Phase
app.get("/api/phase", async (req, res) => {
  try {
    const phase = await getEventPhase();
    const { startMs, endMs } = await getTodayEventWindow();
    const now = Date.now();

    res.json({
      phase,
      msUntilStart: Math.max(0, startMs - now),
      msUntilEnd: Math.max(0, endMs - now),
      serverTime: now,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. User Login / Reconnection
app.post("/api/login", async (req, res) => {
  try {
    const { name, github, language } = req.body;
    if (!github) {
      return res.status(400).json({ ok: false, error: "GitHub Username is required." });
    }

    const username = github.trim();
    const trimmedName = (name || "").trim();
    const selectedLang = language || "C++";

    if (username.length < 2 || username.length > 40) {
      return res.status(400).json({ ok: false, error: "GitHub Username must be 2-40 characters." });
    }

    const phase = await getEventPhase();
    if (phase === "lobby") {
      return res.status(400).json({ ok: false, error: "Event hasn't started yet. Please wait." });
    }
    if (phase === "ended") {
      return res.status(400).json({ ok: false, error: "Event has ended." });
    }

    let p = await storage.getParticipant(username);
    const { endMs } = await getTodayEventWindow();
    const now = Date.now();

    if (p) {
      // Reconnecting participant
      p.disconnects = (p.disconnects || 0) + 1;

      // Lock dynamically if elapsed time exceeds personal timer
      const elapsed = now - p.startTime;
      const userTimeRemaining = Math.max(0, USER_TIMER_MS - elapsed);
      let fixLocked = p.fixLocked || userTimeRemaining <= 0;

      if (userTimeRemaining <= 0 && !p.fixLocked) {
        p.fixLocked = true;
        p.fixLockedAt = p.startTime + USER_TIMER_MS;
      }

      // Check explanation timer
      let explainTimeRemaining = EXPLAIN_TIMER_MS;
      if (p.fixLocked && p.fixLockedAt) {
        const explainElapsed = now - p.fixLockedAt;
        explainTimeRemaining = Math.max(0, EXPLAIN_TIMER_MS - explainElapsed);
        if (explainTimeRemaining <= 0 && !p.finalSubmitted) {
          p.finalSubmitted = true;
          p.finalSubmittedAt = p.fixLockedAt + EXPLAIN_TIMER_MS;
        }
      }

      await storage.setParticipant(username, p);

      return res.json({
        ok: true,
        reconnected: true,
        data: {
          fixCode: p.fixCode,
          fixLocked: fixLocked,
          explanation: p.explanation,
          finalSubmitted: p.finalSubmitted,
          tabSwitchCount: p.tabSwitchCount,
          timeRemainingMs: fixLocked ? 0 : userTimeRemaining,
          explainTimeRemainingMs: fixLocked ? explainTimeRemaining : EXPLAIN_TIMER_MS,
          globalTimeRemainingMs: Math.max(0, endMs - now),
          language: p.language || selectedLang,
        },
      });
    }

    // New participant
    p = {
      username,
      name: trimmedName,
      language: selectedLang,
      startTime: now,
      fixCode: "",
      fixLocked: false,
      fixLockedAt: null,
      explanation: "",
      finalSubmitted: false,
      finalSubmittedAt: null,
      tabSwitchCount: 0,
      disconnects: 0,
    };

    await storage.setParticipant(username, p);

    res.json({
      ok: true,
      reconnected: false,
      data: {
        timeRemainingMs: USER_TIMER_MS,
        explainTimeRemainingMs: EXPLAIN_TIMER_MS,
        globalTimeRemainingMs: Math.max(0, endMs - now),
        language: selectedLang,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. Periodic Fix Code Auto-Save
app.post("/api/fix/update", async (req, res) => {
  try {
    const { username, fixCode } = req.body;
    const p = await storage.getParticipant(username);

    if (!p) return res.status(404).json({ ok: false, error: "Participant not found." });
    if (p.fixLocked || (await getEventPhase()) === "ended") {
      return res.json({ ok: true, locked: true }); // already locked
    }

    const elapsed = Date.now() - p.startTime;
    if (elapsed >= USER_TIMER_MS) {
      p.fixLocked = true;
      p.fixLockedAt = p.startTime + USER_TIMER_MS;
      await storage.setParticipant(username, p);
      return res.json({ ok: true, locked: true });
    }

    p.fixCode = fixCode;
    await storage.setParticipant(username, p);
    res.json({ ok: true, locked: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. Submit Fix (Lock code and proceed to explanation)
app.post("/api/fix/submit", async (req, res) => {
  try {
    const { username, fixCode } = req.body;
    const p = await storage.getParticipant(username);

    if (!p) return res.status(404).json({ ok: false, error: "Participant not found." });
    if (p.fixLocked || (await getEventPhase()) === "ended") {
      return res.status(400).json({ ok: false, error: "Submission window is locked." });
    }

    p.fixCode = fixCode;
    p.fixLocked = true;
    p.fixLockedAt = Date.now();
    
    await storage.setParticipant(username, p);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. Periodic Explanation Auto-Save
app.post("/api/explanation/update", async (req, res) => {
  try {
    const { username, explanation } = req.body;
    const p = await storage.getParticipant(username);

    if (!p) return res.status(404).json({ ok: false, error: "Participant not found." });
    if (p.finalSubmitted || (await getEventPhase()) === "ended") {
      return res.json({ ok: true, locked: true });
    }

    // Check explanation window expiration
    if (p.fixLocked && p.fixLockedAt) {
      const explainElapsed = Date.now() - p.fixLockedAt;
      if (explainElapsed >= EXPLAIN_TIMER_MS) {
        p.finalSubmitted = true;
        p.finalSubmittedAt = p.fixLockedAt + EXPLAIN_TIMER_MS;
        await storage.setParticipant(username, p);
        return res.json({ ok: true, locked: true });
      }
    }

    p.explanation = explanation;
    await storage.setParticipant(username, p);
    res.json({ ok: true, locked: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 6. Final Submit (Fix + Explanation)
app.post("/api/final/submit", async (req, res) => {
  try {
    const { username, explanation } = req.body;
    const p = await storage.getParticipant(username);

    if (!p) return res.status(404).json({ ok: false, error: "Participant not found." });
    if (p.finalSubmitted || (await getEventPhase()) === "ended") {
      return res.status(400).json({ ok: false, error: "Submission window is locked." });
    }

    // Validate word count (50–150 words)
    const wordCount = explanation.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount < 50 || wordCount > 150) {
      return res.status(400).json({
        ok: false,
        error: `Explanation must be 50-150 words. Current: ${wordCount}.`,
      });
    }

    p.explanation = explanation;
    p.finalSubmitted = true;
    p.finalSubmittedAt = Date.now();

    await storage.setParticipant(username, p);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 7. Anti-Cheat: Tab Switch Notification
app.post("/api/anticheat/tabswitch", async (req, res) => {
  try {
    const { username } = req.body;
    const p = await storage.getParticipant(username);

    if (!p) return res.status(404).json({ ok: false, error: "Participant not found." });
    if (p.finalSubmitted || (await getEventPhase()) === "ended") {
      return res.json({ ok: false, error: "Submission closed." });
    }

    p.tabSwitchCount = (p.tabSwitchCount || 0) + 1;
    await storage.setParticipant(username, p);

    res.json({
      ok: true,
      tabSwitchCount: p.tabSwitchCount,
      message: `⚠ Tab switch detected! Count: ${p.tabSwitchCount}`,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 8. Results Export for Administrator
app.get("/api/results", async (req, res) => {
  try {
    const secret = req.query.secret;
    const adminSecret = process.env.ADMIN_SECRET || "admin123";

    if (!secret || secret !== adminSecret) {
      return res.status(403).json({ error: "Unauthorized access to results." });
    }

    const all = await storage.getAllParticipants();
    const phase = await getEventPhase();
    const { endMs } = await getTodayEventWindow();

    const formatted = all.map((p) => {
      let fixLocked = p.fixLocked;
      let fixLockedAt = p.fixLockedAt;
      let finalSubmitted = p.finalSubmitted;
      let finalSubmittedAt = p.finalSubmittedAt;

      // Force locking at global cutoff
      if (phase === "ended") {
        if (!fixLocked) {
          fixLocked = true;
          fixLockedAt = endMs;
        }
        if (!finalSubmitted) {
          finalSubmitted = true;
          finalSubmittedAt = endMs;
        }
      }

      return {
        username: p.username,
        name: p.name,
        language: p.language,
        startTime: p.startTime ? new Date(p.startTime).toISOString() : null,
        fixCode: p.fixCode,
        fixLockedAt: fixLockedAt ? new Date(fixLockedAt).toISOString() : null,
        explanation: p.explanation,
        finalSubmitted: finalSubmitted,
        finalSubmittedAt: finalSubmittedAt ? new Date(finalSubmittedAt).toISOString() : null,
        tabSwitchCount: p.tabSwitchCount,
        disconnects: p.disconnects,
      };
    });

    res.json({
      exportedAt: new Date().toISOString(),
      totalParticipants: formatted.length,
      participants: formatted,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = app;
