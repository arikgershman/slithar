/**
 * input-manager.js — Member 1
 *
 * The bridge between raw input sources (camera gestures, keyboard, mock)
 * and the game engine. Owns all input validation and direction-change logic.
 *
 * Features:
 *  - Confidence threshold filtering (rejects low-confidence gesture events)
 *  - Direction cooldown (prevents same direction spamming in short windows)
 *  - Gesture smoothing: optional majority-vote buffer to reduce false positives
 *  - 180° reversal prevention (can't go directly back into yourself)
 *  - Full keyboard support: arrow keys + WASD + configurable custom keys
 *  - Input source tracking: knows if last input was keyboard, camera, or mock
 *  - Diagnostics mode: logs every event with its accept/reject reason
 *  - Multi-listener support (onDirectionChange)
 *  - Chainable API
 *
 * Usage:
 *   const input = new InputManager({ confidenceThreshold: 0.75 });
 *   input.onDirectionChange(dir => engine.setDirection(dir));
 *   input.enableKeyboard();
 *   gestureDetector.onGesture(e => input.handleGesture(e));
 *   input.syncDirection('RIGHT'); // call after engine reset
 */

import {
  isOppositeDirection,
  isValidDirection,
  DIRECTION_KEYS,
  createGestureEvent,
} from './contracts.js';

// ─── InputManager ─────────────────────────────────────────────────────────────

export class InputManager {

  // ── Config ──────────────────────────────────────────────────────────────────
  #confidenceThreshold;
  #cooldownMs;
  #smoothingWindow;
  #diagnostics;

  // ── State ───────────────────────────────────────────────────────────────────
  #currentDirection  = 'RIGHT';
  #lastChangeTime    = 0;
  #lastSource        = null;    // 'keyboard' | 'camera' | 'mock'
  #smoothingBuffer   = [];      // recent gesture directions for majority vote
  #listeners         = [];
  #keyboardEnabled   = false;
  #keyHandler        = null;
  #stats = {
    accepted:  0,
    rejected:  0,
    reversals: 0,
    throttled: 0,
  };

  /**
   * @param {object} [options]
   * @param {number} [options.confidenceThreshold=0.72]
   *   Gesture events with confidence below this are silently discarded.
   * @param {number} [options.cooldownMs=80]
   *   Minimum ms between accepted direction changes (prevents double-firing).
   * @param {number} [options.smoothingWindow=0]
   *   If > 1, use a majority-vote buffer of this size before accepting a gesture.
   *   0 = disabled (accept immediately). Recommended: 3 for noisy cameras.
   * @param {boolean} [options.diagnostics=false]
   *   Log every input event and why it was accepted or rejected.
   */
  constructor({
    confidenceThreshold = 0.72,
    cooldownMs          = 80,
    smoothingWindow     = 0,
    diagnostics         = false,
  } = {}) {
    this.#confidenceThreshold = confidenceThreshold;
    this.#cooldownMs          = cooldownMs;
    this.#smoothingWindow     = smoothingWindow;
    this.#diagnostics         = diagnostics;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Register a callback fired when a valid, accepted direction change occurs.
   * Multiple listeners are supported.
   * @param {(direction: string) => void} fn
   * @returns {this}
   */
  onDirectionChange(fn) {
    this.#listeners.push(fn);
    return this;
  }

  /**
   * Process a GestureEvent from Member 2's camera detector (or mock emitter).
   * Applies confidence filtering, cooldown, reversal check, and optional smoothing.
   * @param {import('./contracts.js').GestureEvent} event
   */
  handleGesture(event) {
    const src = event.source ?? 'camera';

    // 1. Confidence gate
    if (event.confidence < this.#confidenceThreshold) {
      this.#log(`REJECT [low confidence ${event.confidence.toFixed(2)} < ${this.#confidenceThreshold}] ${event.direction}`);
      this.#stats.rejected++;
      return;
    }

    // 2. Smoothing / majority vote
    if (this.#smoothingWindow > 1) {
      this.#smoothingBuffer.push(event.direction);
      if (this.#smoothingBuffer.length > this.#smoothingWindow) {
        this.#smoothingBuffer.shift();
      }
      const majority = this.#majorityVote(this.#smoothingBuffer);
      if (!majority) {
        this.#log(`SMOOTH [no majority yet] ${event.direction} buffer=[${this.#smoothingBuffer}]`);
        return;
      }
      this.#tryAccept(majority, src);
    } else {
      this.#tryAccept(event.direction, src);
    }
  }

  /**
   * Enable arrow key + WASD keyboard control.
   * Safe to call multiple times — subsequent calls are no-ops.
   * @param {object} [customKeyMap] — override or extend the default key map
   * @returns {this}
   */
  enableKeyboard(customKeyMap = {}) {
    if (this.#keyboardEnabled) return this;
    this.#keyboardEnabled = true;

    const keyMap = {
      ArrowUp:    'UP',
      ArrowDown:  'DOWN',
      ArrowLeft:  'LEFT',
      ArrowRight: 'RIGHT',
      w: 'UP',  W: 'UP',
      s: 'DOWN', S: 'DOWN',
      a: 'LEFT', A: 'LEFT',
      d: 'RIGHT', D: 'RIGHT',
      ...customKeyMap,
    };

    this.#keyHandler = (e) => {
      const dir = keyMap[e.key];
      if (!dir) return;
      e.preventDefault();
      // Synthesize a gesture event so the same validation pipeline runs
      const synthetic = createGestureEvent(dir, 1.0, 'keyboard');
      this.#tryAccept(synthetic.direction, 'keyboard');
    };

    window.addEventListener('keydown', this.#keyHandler);
    this.#log('Keyboard enabled');
    return this;
  }

  /** Remove keyboard listener and disable keyboard input. */
  disableKeyboard() {
    if (!this.#keyboardEnabled || !this.#keyHandler) return this;
    window.removeEventListener('keydown', this.#keyHandler);
    this.#keyboardEnabled = false;
    this.#keyHandler      = null;
    this.#log('Keyboard disabled');
    return this;
  }

  /**
   * Sync the InputManager's known direction to the engine's actual direction.
   * Call this after engine.reset() or engine.start() so the reversal check
   * doesn't use a stale direction from the previous game.
   * @param {'UP'|'DOWN'|'LEFT'|'RIGHT'} direction
   * @returns {this}
   */
  syncDirection(direction) {
    if (isValidDirection(direction)) {
      this.#currentDirection = direction;
      this.#smoothingBuffer  = [];
      this.#log(`Direction synced to ${direction}`);
    }
    return this;
  }

  /**
   * Update the confidence threshold at runtime (e.g. let the user tune it).
   * @param {number} threshold — 0.0–1.0
   * @returns {this}
   */
  setConfidenceThreshold(threshold) {
    if (typeof threshold === 'number' && threshold >= 0 && threshold <= 1) {
      this.#confidenceThreshold = threshold;
    }
    return this;
  }

  /** Enable/disable diagnostic logging at runtime */
  setDiagnostics(enabled) {
    this.#diagnostics = enabled;
    return this;
  }

  /** Read current direction the InputManager believes is active */
  getCurrentDirection() {
    return this.#currentDirection;
  }

  /** Returns which input source fired the most recent accepted direction */
  getLastSource() {
    return this.#lastSource;
  }

  /**
   * Snapshot of accept/reject counters — useful for UI debug panels.
   * @returns {{ accepted, rejected, reversals, throttled }}
   */
  getStats() {
    return { ...this.#stats };
  }

  /** Reset stats counters */
  resetStats() {
    this.#stats = { accepted: 0, rejected: 0, reversals: 0, throttled: 0 };
    return this;
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  /**
   * Final validation gate. Applies cooldown and reversal checks,
   * then fires listeners if the direction is accepted.
   */
  #tryAccept(direction, source) {
    if (!isValidDirection(direction)) {
      this.#log(`REJECT [invalid direction] ${direction}`);
      this.#stats.rejected++;
      return;
    }

    // 180° reversal guard
    if (isOppositeDirection(direction, this.#currentDirection)) {
      this.#log(`REJECT [reversal] ${this.#currentDirection} → ${direction}`);
      this.#stats.reversals++;
      return;
    }

    // Same direction — no need to fire
    if (direction === this.#currentDirection) {
      this.#log(`SKIP [same direction] ${direction}`);
      return;
    }

    // Cooldown guard — prevents double-firing on held keys or rapid gestures
    const now = Date.now();
    if (now - this.#lastChangeTime < this.#cooldownMs) {
      this.#log(`REJECT [cooldown ${now - this.#lastChangeTime}ms < ${this.#cooldownMs}ms] ${direction}`);
      this.#stats.throttled++;
      return;
    }

    // ✓ Accepted
    this.#currentDirection = direction;
    this.#lastChangeTime   = now;
    this.#lastSource       = source;
    this.#stats.accepted++;
    this.#log(`ACCEPT [${source}] ${direction}`);

    this.#listeners.forEach(fn => fn(direction));
  }

  /** Returns the most common element in an array, or null if there's a tie */
  #majorityVote(arr) {
    if (!arr.length) return null;
    const counts = {};
    let max = 0;
    let winner = null;
    for (const v of arr) {
      counts[v] = (counts[v] ?? 0) + 1;
      if (counts[v] > max) { max = counts[v]; winner = v; }
    }
    // Must be a strict majority (> half the window)
    return max > arr.length / 2 ? winner : null;
  }

  #log(msg) {
    if (this.#diagnostics) {
      console.debug(`[InputManager] ${msg}`);
    }
  }
}
