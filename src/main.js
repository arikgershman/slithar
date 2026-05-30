/**
 * main.js — Member 4 (Integration)
 *
 * Wires all four modules together. The ONLY file that imports from multiple
 * modules. Everything else exports only.
 *
 * Feature flags at the top — flip them without touching any other file.
 */

import { GameEngine, EVENTS, POWERUP_TYPE } from './game-engine.js';
import { Renderer }                          from './renderer.js';
import { InputManager }                      from './input-manager.js';
import { GestureDetector }                   from './gesture-detector.js';
import { MockGestureEmitter }                from './mock-gesture-emitter.js';
import { GAME_STATUS }                       from './contracts.js';

// ─── Feature Flags ────────────────────────────────────────────────────────────
const USE_CAMERA = true;    // camera is wired in; serve over http://localhost for getUserMedia
const USE_MOCK   = false;   // ← flip true for random-gesture testing
// both false = keyboard only (arrow keys / WASD + Space)

// ─── DOM Refs ─────────────────────────────────────────────────────────────────
const canvas        = document.getElementById('game-canvas');
const videoEl       = document.getElementById('camera-feed');
const overlayCanvas = document.getElementById('camera-overlay');
const cameraWrap    = document.getElementById('camera-wrap');

const scoreEl       = document.getElementById('score-display');
const highScoreEl   = document.getElementById('high-score-display');
const levelEl       = document.getElementById('level-display');
const comboEl       = document.getElementById('combo-display');
const effectsEl     = document.getElementById('effects-display');
const gestureEl     = document.getElementById('gesture-display');

const startBtn      = document.getElementById('btn-start');
const pauseBtn      = document.getElementById('btn-pause');
const resetBtn      = document.getElementById('btn-reset');

// ─── Instances ────────────────────────────────────────────────────────────────
const engine   = new GameEngine();
const renderer = new Renderer(canvas);
const input    = new InputManager({ confidenceThreshold: 0.7 });

// ─── Engine → Renderer + UI ──────────────────────────────────────────────────
engine.onStateChange((state) => {
  renderer.draw(state);
  updateHUD(state);
});

// ─── Engine Named Events → Renderer Notifications ────────────────────────────
engine.on(EVENTS.FOOD_EATEN, (payload) => {
  const foodPos = engine.getState().food; // food just moved to new pos; use prev
  renderer.notifyFoodEaten(payload, engine.getState().snake[0]);
  flashScore();
});

engine.on(EVENTS.SHIELD_HIT, () => {
  renderer.notifyShieldHit();
  showToast('🛡 Shield absorbed hit!', 'shield');
});

engine.on(EVENTS.POWERUP_GRAB, (payload) => {
  const head = engine.getState().snake[0];
  renderer.notifyPowerUpGrab(payload, head);
  showToast(powerUpToast(payload.type), 'powerup');
});

engine.on(EVENTS.POWERUP_END, ({ type }) => {
  showToast(`${powerUpIcon(type)} ${type} expired`, 'muted');
});

engine.on(EVENTS.LEVEL_UP, (payload) => {
  renderer.notifyLevelUp(payload);
  showToast(`⬆ LEVEL ${payload.level}`, 'level');
});

engine.on(EVENTS.GAME_OVER, ({ score, highScore, isNewRecord }) => {
  if (isNewRecord) showToast('★ NEW HIGH SCORE!', 'record');
  highScoreEl.textContent = `Best: ${highScore}`;
  updateButtonStates(GAME_STATUS.GAME_OVER);
});

// ─── Input → Engine ──────────────────────────────────────────────────────────
input.onDirectionChange((dir) => {
  engine.setDirection(dir);
  setGestureDisplay(dir, 1.0, false);
});

input.enableKeyboard();

// ─── Camera / Mock Setup ─────────────────────────────────────────────────────
let activeDetector = null;

if (USE_CAMERA) {
  const detector = new GestureDetector({
    videoEl,
    overlayCanvas,
    debounceMs:      280,
    stabilityFrames: 2,
    showDebug:       true,
  });

  detector.onGesture((e) => {
    input.handleGesture(e);
    setGestureDisplay(e.direction, e.confidence, true);
  });

  // Hand proximity → dynamic snake speed.
  // Detector fires per-frame; engine clamps the multiplier itself.
  detector.onProximity((p) => {
    engine.setSpeedFactor(p.speedFactor);
    updateProximityMeter(p);
  });

  detector.start()
    .then(() => {
      cameraWrap.classList.remove('is-off');
      document.getElementById('camera-debug-card').style.display = 'block';
      showToast('📷 Camera ready — point your finger!', 'level');
      // Poll debug info at 10fps for the debug panel
      setInterval(() => updateCameraDebug(detector.getDebugInfo()), 100);
    })
    .catch(err => {
      console.error('[Camera]', err);
      cameraWrap.classList.add('is-off');
      showToast('⚠ Camera unavailable — using keyboard', 'muted');
    });

  activeDetector = detector;
}

if (USE_MOCK && !USE_CAMERA) {
  const mock = new MockGestureEmitter();
  mock.onGesture((e) => {
    input.handleGesture(e);
    setGestureDisplay(e.direction, e.confidence, true);
  });
  mock.startRandom(650);
}

// ─── Button Handlers ─────────────────────────────────────────────────────────
startBtn.addEventListener('click', () => {
  const s = engine.getState().status;
  if (s === GAME_STATUS.IDLE || s === GAME_STATUS.GAME_OVER) {
    engine.start();
    input.syncDirection('RIGHT');
  }
});

pauseBtn.addEventListener('click', () => {
  const s = engine.getState().status;
  if (s === GAME_STATUS.RUNNING) engine.pause();
  else if (s === GAME_STATUS.PAUSED) engine.resume();
});

resetBtn.addEventListener('click', () => {
  engine.reset();
  input.syncDirection('RIGHT');
});

// Space = start / pause toggle
window.addEventListener('keydown', (e) => {
  if (e.code !== 'Space') return;
  e.preventDefault();
  const s = engine.getState().status;
  if (s === GAME_STATUS.IDLE || s === GAME_STATUS.GAME_OVER) { engine.start(); input.syncDirection('RIGHT'); }
  else if (s === GAME_STATUS.RUNNING) engine.pause();
  else if (s === GAME_STATUS.PAUSED)  engine.resume();
});

// ─── HUD Updates ─────────────────────────────────────────────────────────────
function updateHUD(state) {
  scoreEl.textContent    = state.score;
  levelEl.textContent    = `LVL ${state.level ?? 1}`;
  comboEl.textContent    = state.combo > 1 ? `×${state.combo} COMBO` : '';
  comboEl.className      = state.combo > 1 ? 'combo-active' : '';
  highScoreEl.textContent = `Best: ${state.highScore ?? 0}`;
  updateEffects(state.activeEffects ?? []);
  updateButtonStates(state.status);
}

function updateEffects(activeEffects) {
  effectsEl.innerHTML = activeEffects.map(type =>
    `<span class="effect-badge effect-${type.toLowerCase()}">${powerUpIcon(type)} ${type}</span>`
  ).join('');
}

function updateButtonStates(status) {
  startBtn.disabled = status === GAME_STATUS.RUNNING || status === GAME_STATUS.PAUSED;
  pauseBtn.disabled = status !== GAME_STATUS.RUNNING && status !== GAME_STATUS.PAUSED;
  pauseBtn.textContent = status === GAME_STATUS.PAUSED ? '▶ Resume' : '⏸ Pause';
  resetBtn.disabled = status === GAME_STATUS.IDLE;
}

function flashScore() {
  scoreEl.classList.remove('flash');
  void scoreEl.offsetWidth; // reflow trick to restart animation
  scoreEl.classList.add('flash');
}

// ─── Gesture Display ─────────────────────────────────────────────────────────
const DIR_ARROWS = { UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→' };

function setGestureDisplay(direction, confidence, isCamera) {
  const arrow = DIR_ARROWS[direction] ?? '?';
  const pct   = Math.round(confidence * 100);
  gestureEl.textContent = isCamera
    ? `👋 ${arrow} ${direction} (${pct}%)`
    : `⌨ ${arrow} ${direction}`;
  gestureEl.className = 'gesture-active';
  clearTimeout(gestureEl._resetTimer);
  gestureEl._resetTimer = setTimeout(() => {
    gestureEl.className = '';
  }, 600);
}

// ─── Toast Notifications ──────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent  = msg;
  toast.className    = `toast toast-${type} visible`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast'; }, 2200);
}

// ─── Proximity Meter (hand-distance → snake speed) ───────────────────────────
const proxFill   = document.getElementById('prox-fill');
const proxSpeed  = document.getElementById('prox-speed');
const proxLabel  = document.getElementById('prox-label');

function updateProximityMeter({ t, speedFactor, handVisible }) {
  if (!proxFill) return; // panel not present
  proxFill.style.width = `${(t * 100).toFixed(0)}%`;
  // 1.0 = level default; <1 = faster (good in HUD), >1 = slower.
  // Show as a multiplier the player intuits (close = faster snake).
  const xMul = (1 / speedFactor).toFixed(2);
  proxSpeed.textContent = `${xMul}×`;
  if (!handVisible)        proxLabel.textContent = '— no hand —';
  else if (t < 0.25)       proxLabel.textContent = 'FAR · slow';
  else if (t < 0.55)       proxLabel.textContent = 'NORMAL';
  else if (t < 0.85)       proxLabel.textContent = 'CLOSE · fast';
  else                     proxLabel.textContent = 'TOO CLOSE!';
  proxFill.classList.toggle('hot', t > 0.75);
}

// ─── Camera Debug Panel ───────────────────────────────────────────────────────
function updateCameraDebug(info) {
  if (!info) return;

  const dirEl  = document.getElementById('dbg-direction');
  const confEl = document.getElementById('dbg-confidence');
  const arrows = { UP: '↑ UP', DOWN: '↓ DOWN', LEFT: '← LEFT', RIGHT: '→ RIGHT' };

  if (dirEl)  dirEl.textContent  = info.direction ? arrows[info.direction] : '—';
  if (confEl) confEl.textContent = info.direction
    ? `${(info.confidence * 100).toFixed(0)}%`
    : '—';

  // Stability dots
  for (let i = 0; i < 2; i++) {
    const dot = document.getElementById(`stab-${i}`);
    if (dot) dot.classList.toggle('filled', info.stable || false);
  }

  // Finger indicators
  const fingerIds = ['fi-index', 'fi-middle', 'fi-ring', 'fi-pinky'];
  (info.fingers ?? []).forEach((extended, i) => {
    const el = document.getElementById(fingerIds[i]);
    if (el) el.classList.toggle('extended', extended);
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────────
function powerUpIcon(type) {
  return { SHIELD: '🛡', MULTIPLIER: '×2', SLOW: '❄' }[type] ?? '?';
}

function powerUpToast(type) {
  return {
    SHIELD:     '🛡 Shield active — one free hit!',
    MULTIPLIER: '×2 Score multiplier active!',
    SLOW:       '❄ Slowed down!',
  }[type] ?? `Power-up: ${type}`;
}

// ─── Initial State ────────────────────────────────────────────────────────────
renderer.draw(engine.getState());
updateHUD(engine.getState());
updateButtonStates(GAME_STATUS.IDLE);
