# SlithAR: A Vision-Driven Gesture Control System for Arcade Gaming 🐍

[![DOI](https://img.shields.io/badge/DOI-10.13140%2FRG.2.2.10554.35526-blue)](https://doi.org/10.13140/RG.2.2.10554.35526)

A browser-based Snake game controlled by hand gestures via your webcam, using MediaPipe Hands for real-time computer vision.

📖 **Read the paper:** [SlithAR: A Vision-Driven Gesture Control System for Arcade Gaming](https://doi.org/10.13140/RG.2.2.10554.35526)

---

## 🗂 Project Structure

```
snake-gesture-game/
├── index.html              ← Entry point (Member 4)
└── src/
    ├── contracts.js         ← Shared types & constants (Member 1) ⚠️ read-only
    ├── input-manager.js     ← Gesture → direction bridge (Member 1)
    ├── mock-gesture-emitter.js ← Dev tool for testing without camera (Member 1)
    ├── gesture-detector.js  ← MediaPipe camera + hand tracking (Member 2)
    ├── game-engine.js       ← Pure game logic (Member 3)
    ├── renderer.js          ← Canvas drawing (Member 4)
    └── main.js              ← Wires everything together (Member 4)
```

---

## 👥 Team Responsibilities

| Member | Files | Focus |
|--------|-------|-------|
| **1 — Integration Lead** | `contracts.js`, `input-manager.js`, `mock-gesture-emitter.js` | Shared interfaces, input validation, dev tooling |
| **2 — Computer Vision** | `gesture-detector.js` | Camera, MediaPipe, gesture classification |
| **3 — Game Engine** | `game-engine.js` | Snake logic, collision, scoring, game loop |
| **4 — UI / Integration** | `renderer.js`, `main.js`, `index.html` | Canvas rendering, buttons, wiring all modules |

---

## 🚀 Getting Started

### Option A — VS Code Live Server
1. Install the **Live Server** extension in VS Code
2. Right-click `index.html` → **Open with Live Server**

### Option B — Python HTTP Server
```bash
python3 -m http.server 8080
# then open http://localhost:8080
```

### Option C — Node
```bash
npx serve .
```

> ⚠️ **Do not open `index.html` directly as a `file://` URL.** ES modules and the camera API require a local server.

---

## 🔧 Feature Flags (in `src/main.js`)

```js
const USE_CAMERA = false;  // true = live webcam (needs Member 2 done)
const USE_MOCK   = false;  // true = random gesture emitter (for testing)
// both false = keyboard only (arrow keys / WASD + Space)
```

Switch these without touching any other file.

---

## 📐 Shared Contract Rules

> **`contracts.js` is read-only for Members 2, 3, and 4.**
> Any change requires full group agreement and must be communicated to all members.

Key shapes:

```js
// GestureEvent (Member 2 produces, Member 1 consumes)
{ direction: 'UP'|'DOWN'|'LEFT'|'RIGHT', confidence: 0.0–1.0, timestamp: ms }

// GameState (Member 3 produces, Member 4 consumes)
{ status, snake: [{x,y}], food: {x,y}, direction, score, tick }
```

---

## 🤝 Collaboration Guidelines

- **No two members edit the same file at the same time**
- **`main.js` is Member 4's file** — others export, never import each other directly
- Use the **mock emitter** to test without needing the camera
- Use **keyboard mode** to test without needing gestures at all
- Communicate on Discord/Slack before changing `contracts.js`

---

## 🛠 Tech Stack

- **Vanilla JS (ES Modules)** — no build step required
- **MediaPipe Hands** — browser-native hand tracking via CDN
- **HTML5 Canvas** — game rendering
- **No backend** — runs entirely in the browser

---

## 📚 Useful Links

- [MediaPipe Hands Docs](https://developers.google.com/mediapipe/solutions/vision/hand_landmarker)
- [MediaPipe JS Examples](https://mediapipe-studio.webapps.google.com/studio/demo/hand_landmarker)
- [Hand Landmark Map](https://developers.google.com/mediapipe/solutions/vision/hand_landmarker#models) — use this for gesture classification
