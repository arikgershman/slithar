/**
 * mock-gesture-emitter.js — Member 1
 *
 * Fires scripted or random GestureEvents so all other members can develop
 * and test without a real camera. Also useful for demos and stress testing.
 *
 * Features:
 *  - Random mode: fires at a configurable interval with configurable confidence
 *  - Script mode: plays a predefined sequence of directions
 *  - Loop mode: repeats a script forever
 *  - Adaptive mode: avoids immediate reversals (mimics realistic hand use)
 *  - Stress test mode: fires as fast as possible to test input-manager throttling
 *  - Per-event confidence noise: simulate camera uncertainty
 *  - Event history: last N events recorded for debugging
 *  - Multiple listeners
 *
 * Usage:
 *   const mock = new MockGestureEmitter();
 *   mock.onGesture(e => inputManager.handleGesture(e));
 *
 *   mock.startRandom();               // random directions every 700ms
 *   mock.startRandom(400, true);      // adaptive — no immediate reversals
 *   mock.runScript(['UP','UP','RIGHT','DOWN'], 500);
 *   mock.runScript(['UP','RIGHT','DOWN','LEFT'], 400, { loop: true });
 *   mock.stressTest(50);              // fire every 50ms to test throttle
 *   mock.fire('UP');                  // fire a single event manually
 *   mock.stop();
 *   mock.getHistory(10);              // last 10 fired events
 */

import {
  createGestureEvent,
  DIRECTION_KEYS,
  OPPOSITE_DIRECTION,
} from './contracts.js';

export class MockGestureEmitter {
  #listeners   = [];
  #timerId     = null;
  #history     = [];
  #maxHistory  = 50;
  #running     = false;

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Register a callback fired with each GestureEvent.
   * @param {(event: import('./contracts.js').GestureEvent) => void} fn
   * @returns {this}
   */
  onGesture(fn) {
    this.#listeners.push(fn);
    return this;
  }

  /**
   * Fire random directions at a regular interval.
   * @param {number} [intervalMs=700]
   * @param {boolean} [adaptive=true]
   *   If true, never fires the direct opposite of the previous direction,
   *   which mimics how a real hand naturally moves.
   * @param {number} [confidenceBase=0.88]
   *   Base confidence. Each event adds ±0.08 noise.
   * @returns {this}
   */
  startRandom(intervalMs = 700, adaptive = true, confidenceBase = 0.88) {
    this.stop();
    this.#running = true;
    let lastDir = 'RIGHT';

    const tick = () => {
      if (!this.#running) return;

      let candidates = [...DIRECTION_KEYS];
      if (adaptive) {
        const opp = OPPOSITE_DIRECTION[lastDir];
        candidates = candidates.filter(d => d !== opp);
      }

      const dir        = candidates[Math.floor(Math.random() * candidates.length)];
      const confidence = Math.min(1, Math.max(0.5,
        confidenceBase + (Math.random() - 0.5) * 0.16
      ));

      lastDir = dir;
      this.#fireAndRecord(dir, confidence, 'mock');
      this.#timerId = setTimeout(tick, intervalMs);
    };

    this.#timerId = setTimeout(tick, intervalMs);
    return this;
  }

  /**
   * Play a scripted sequence of directions.
   * @param {string[]} directions  — array of 'UP'|'DOWN'|'LEFT'|'RIGHT'
   * @param {number}   [delayMs=600] — ms between each step
   * @param {object}   [options]
   * @param {boolean}  [options.loop=false]   — repeat forever
   * @param {number}   [options.confidence=1.0]
   * @returns {Promise<void>}  resolves when the script finishes (non-looping only)
   */
  async runScript(directions, delayMs = 600, { loop = false, confidence = 1.0 } = {}) {
    this.stop();
    this.#running = true;

    const play = async () => {
      for (const dir of directions) {
        if (!this.#running) return;
        await this.#delay(delayMs);
        if (!this.#running) return;
        this.#fireAndRecord(dir, confidence, 'mock');
      }
      if (loop && this.#running) await play();
    };

    await play();
  }

  /**
   * Fire as fast as possible to stress-test the InputManager's throttle/cooldown.
   * @param {number} [intervalMs=30] — very short interval
   * @returns {this}
   */
  stressTest(intervalMs = 30) {
    return this.startRandom(intervalMs, false, 1.0);
  }

  /**
   * Fire a single gesture event immediately.
   * @param {'UP'|'DOWN'|'LEFT'|'RIGHT'} direction
   * @param {number} [confidence=1.0]
   * @returns {this}
   */
  fire(direction, confidence = 1.0) {
    this.#fireAndRecord(direction, confidence, 'mock');
    return this;
  }

  /**
   * Fire a low-confidence event (tests that InputManager correctly rejects it).
   * @param {'UP'|'DOWN'|'LEFT'|'RIGHT'} direction
   * @returns {this}
   */
  fireLowConfidence(direction) {
    return this.fire(direction, 0.2);
  }

  /** Stop any running random/script/stress mode. */
  stop() {
    this.#running = false;
    if (this.#timerId !== null) {
      clearTimeout(this.#timerId);
      clearInterval(this.#timerId);
      this.#timerId = null;
    }
    return this;
  }

  /** True if currently running */
  get isRunning() {
    return this.#running;
  }

  /**
   * Return the last `n` fired events (default: all stored).
   * @param {number} [n]
   * @returns {import('./contracts.js').GestureEvent[]}
   */
  getHistory(n) {
    return n != null
      ? this.#history.slice(-n)
      : [...this.#history];
  }

  /** Clear event history */
  clearHistory() {
    this.#history = [];
    return this;
  }

  // ─── Private ─────────────────────────────────────────────────────────────────

  #fireAndRecord(direction, confidence, source) {
    const event = createGestureEvent(direction, confidence, source);
    this.#history.push(event);
    if (this.#history.length > this.#maxHistory) this.#history.shift();
    this.#listeners.forEach(fn => fn(event));
  }

  #delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
