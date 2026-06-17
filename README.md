# ⚡ AUTOMATA FIX CHALLENGE

> A serverless, real-time, anti-cheat competitive programming event platform built for Vercel, Express, and MongoDB.

Participants race against the clock to fix bugs in Drone Path Validator code within a strict global event window. The app features secure client-side canvas rendering (no copy-paste), tab switch monitoring, and automatic persistence.

---

## 🏗️ Tech Stack

| Layer | Technology |
|---|---|
| **Hosting & Functions** | Vercel Serverless Functions |
| **Backend Framework** | Express (Node.js) |
| **Real-time Synchronization** | HTTP API Polling (3s interval) |
| **Problem Rendering** | Client-Side HTML5 Canvas (Select-proof) |
| **Database & Persistence** | MongoDB (Production) / Local File Backup (Development) |
| **Fonts** | JetBrains Mono, Orbitron (Google Fonts) |

---

## 📂 Project Structure

```
automata-challenge/
├── api/
│   └── server.js                # Main Serverless Router (Express API)
├── public/
│   └── index.html               # Single-page frontend (all UI states)
├── server.js                    # Local launcher for offline development
├── vercel.json                  # Vercel deployment configurations
├── package.json                 # Project dependencies & scripts
├── README.md                    # This file
└── how_to_toggle_test_mode.txt   # Guide for toggling test mode
```

---

## 🚀 Quick Start (Local Development)

### Prerequisites
- Node.js v18+
- npm

### Installation
```bash
# Install dependencies
npm install
```

### Run Locally (Offline Mode)
```bash
npm run dev
```
The server will start on **http://localhost:3000** in local development mode. In this mode:
* Databases automatically fall back to saving local JSON files (`participants_backup.json`).
* You do not need to configure MongoDB or Vercel environment variables to test locally.

---

## 🕐 Event Flow

The entire event runs within a **strict 60-minute window** from **18:00 IST to 19:00 IST**.

```
18:00 IST                                              19:00 IST
   │                                                       │
   ▼                                                       ▼
   ┌──────────────────────────────────────────────────────┐
   │              GLOBAL EVENT WINDOW (60 min)            │
   │                                                      │
   │  User joins at any point ──┐                         │
   │                            ▼                         │
   │                 ┌── 15 min Fix ──┐                   │
   │                 │  Write answer  │                   │
   │                 └───────┬────────┘                   │
   │                         ▼                            │
   │                 ┌── Explanation ──┐                   │
   │                 │  50-150 words   │                   │
   │                 │  (10 minutes)   │                   │
   │                 └───────┬────────┘                   │
   │                         ▼                            │
   │                    ✅ SUBMITTED                       │
   └──────────────────────────────────────────────────────┘
                                                           │
                                                    📄 Results
                                                       downloadable
                                                       via /api/results
```

### Phase Breakdown

| Phase | Description |
|---|---|
| **Lobby** | Before 18:00 IST — countdown timer shown, no login allowed |
| **Login** | 18:00 IST — API polling shifts lobby into login screen |
| **Fix Phase** | 15 minutes per user — fix the broken code for the Drone Path Validator |
| **Explanation** | 10 minutes per user — write a 50-150 word logic defense |
| **Done** | Submission complete — user sees confirmation |
| **Event Ended** | 19:00 IST — all entries locked globally |

---

## 🛡️ Anti-Cheat System

| Measure | Implementation |
|---|---|
| **Problem as Image** | Client draws the problem text on an HTML5 `<canvas>` — preventing copying, selecting, or right-clicking. |
| **Right-click Disabled** | `contextmenu` events intercepted and disabled. |
| **Copy/Paste Blocked** | `Ctrl+C/V/U/S/A` (and MacOS `Cmd` equivalents) intercepted globally. |
| **Paste on Explanation** | `paste` event blocked on explanation textarea. |
| **Tab Switch Tracking** | `visibilitychange` API tracks switches, sends counts to the server, and flashes a warning banner. |
| **DevTools Blocked** | `F12`, `Ctrl+Shift+I/J/C`, and `Cmd+Option+I/J/C` intercepted. |
| **Camera Deterrent** | Camera permission is requested at login to create a "serious environment", though video is not recorded or transmitted. |
| **Server-Side Timer** | 15-minute locks enforced server-side, not just in the UI. |

---

## 💾 Data Persistence & MongoDB

### In Production
When deployed on Vercel with `MONGODB_URI` environment variable set:
* All operations (logins, saves, submissions, tab switches) are written instantly to MongoDB collections.
* Database connection caching is implemented to optimize Vercel serverless function warmups.

### Local Development Fallback
When no database URL is set:
* State falls back to writing directly to `participants_backup.json` in the root directory.

### Admin Results Download
Final participant data can be exported securely as a formatted JSON file by going to:
`https://your-vercel-domain.vercel.app/api/results?secret=YOUR_ADMIN_SECRET`

---

## 🔄 Reconnection Support

If a participant refreshes the page or loses connection:
1. They enter their **GitHub username** to reconnect.
2. The server restores their exact state from MongoDB/KV (timer values, code, explanation, and tab switches).
3. The server increments a `disconnects` counter for transparency/audit.

---

## ⚙️ Configuration

Key configuration constants are in `api/server.js`:

| Constant | Default | Description |
|---|---|---|
| `USER_TIMER_MS` | `15 * 60 * 1000` (15m) | Duration for fix phase |
| `EXPLAIN_TIMER_MS` | `10 * 60 * 1000` (10m) | Duration for explanation phase |
| `TEST_MODE` | `false` | Enable simulated fast-event timelines |

Before deploying, set `MONGODB_URI` and `ADMIN_SECRET` as environment variables in Vercel.

---

## 📡 API Endpoints

### Client ↔️ Serverless Router

| Endpoint | Method | Payload | Description |
|---|---|---|---|
| `/api/phase` | GET | None | Fetch current phase details and global timing |
| `/api/login` | POST | `{ name, github, language }` | Login user or recover existing session |
| `/api/fix/update` | POST | `{ username, fixCode }` | Auto-save code fix |
| `/api/fix/submit` | POST | `{ username, fixCode }` | Submit code early and lock editor |
| `/api/explanation/update`| POST | `{ username, explanation }`| Auto-save explanation text (1s debounced) |
| `/api/final/submit` | POST | `{ username, explanation }`| Final submission (validates 50-150 words) |
| `/api/anticheat/tabswitch`| POST | `{ username }` | Log a tab switch event |
| `/api/results` | GET | `?secret=...` | Securely export final results dataset |

---

## 🎨 UI Design

- **Aesthetic**: Dark-mode hacker/cyberpunk theme
- **Fonts**: Orbitron (display), JetBrains Mono (code)
- **Effects**: Animated grid background, scanline overlay, glow effects, pulse animations
- **Colors**: Cyber green (`#00ff88`), amber warnings (`#ffcc00`), red alerts (`#ff4444`)
- **Responsive**: Works on desktop and tablet

---

<p align="center">
  <strong>Built for competitive programming events.</strong><br/>
  <em>Serverless, lightweight, secure, and stateful.</em>
</p>
