/**
 * gesture-detector.js — Member 2
 *
 * Webcam access, MediaPipe Hands integration, landmark processing,
 * and gesture classification. Outputs GestureEvents via contracts.js.
 *
 * Self-contained: only imports from contracts.js.
 * Never touches the game engine, renderer, or input manager directly.
 *
 * ── Gesture vocabulary ──────────────────────────────────────────────────────
 *
 *  UP    — index finger pointing up    (finger tip above wrist, dominant vertical)
 *  DOWN  — index finger pointing down  (finger tip below wrist, dominant vertical)
 *  LEFT  — index finger pointing left  (finger tip left of wrist, dominant horizontal)
 *  RIGHT — index finger pointing right (finger tip right of wrist, dominant horizontal)
 *
 *  All four gestures require the index finger to be clearly extended while
 *  the other three fingers (middle, ring, pinky) are curled. This prevents
 *  accidental triggers from open-palm or fist positions.
 *
 * ── Classification pipeline ─────────────────────────────────────────────────
 *
 *  1. Finger state analysis   — determine which fingers are extended/curled
 *  2. Pointing check          — index must be extended, others mostly curled
 *  3. Direction vector        — wrist → index tip gives raw direction
 *  4. Axis dominance check    — reject ambiguous diagonal poses
 *  5. Confidence calculation  — combines magnitude, axis clarity, finger state
 *  6. Temporal stability      — require N consecutive matching frames (hysteresis)
 *  7. Debounce                — minimum ms gap between emitted events
 *
 * ── Usage ────────────────────────────────────────────────────────────────────
 *
 *   const detector = new GestureDetector({ videoEl, overlayCanvas });
 *   detector.onGesture(e => inputManager.handleGesture(e));
 *   await detector.start();
 *   // ... game runs ...
 *   detector.stop();
 *
 * ── Required CDN scripts in index.html ───────────────────────────────────────
 *
 *   <script src="https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js"></script>
 *   <script src="https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js"></script>
 *   <script src="https://cdn.jsdelivr.net/npm/@mediapipe/drawing_utils/drawing_utils.js"></script>
 */

import { createGestureEvent } from './contracts.js';

// ─── MediaPipe landmark indices ───────────────────────────────────────────────
// Full hand has 21 landmarks. We name the ones we actually use.
const LM = Object.freeze({
  WRIST:         0,
  THUMB_CMC:     1,
  THUMB_MCP:     2,
  THUMB_IP:      3,
  THUMB_TIP:     4,
  INDEX_MCP:     5,
  INDEX_PIP:     6,
  INDEX_DIP:     7,
  INDEX_TIP:     8,
  MIDDLE_MCP:    9,
  MIDDLE_PIP:   10,
  MIDDLE_DIP:   11,
  MIDDLE_TIP:   12,
  RING_MCP:     13,
  RING_PIP:     14,
  RING_DIP:     15,
  RING_TIP:     16,
  PINKY_MCP:    17,
  PINKY_PIP:    18,
  PINKY_DIP:    19,
  PINKY_TIP:    20,
});

// ─── Tuning constants ─────────────────────────────────────────────────────────

// Minimum wrist→index-tip distance (normalised 0–1) to be considered pointing.
// Smaller = more sensitive but more false positives from partial gestures.
const MIN_POINTING_MAGNITUDE = 0.15;

// Axis dominance ratio: |dominant axis| / |other axis| must exceed this.
// Higher = stricter (rejects diagonals more aggressively). 1.4 works well.
const AXIS_DOMINANCE_RATIO = 1.4;

// Fraction of PIP-to-TIP distance at which a finger counts as "curled".
// A finger is curled when its tip is closer to the wrist than its PIP joint.
// Tune upward (e.g. 1.1) to be stricter about requiring curled fingers.
const CURL_THRESHOLD = 1.05;

// Number of consecutive frames that must agree on a direction before emitting.
// Higher = less jitter but more latency. 2–3 is a good balance.
const STABILITY_FRAMES = 2;

// Minimum ms between emitted gesture events (hard debounce on top of stability).
const DEBOUNCE_MS = 280;

// Minimum confidence score (0–1) to emit an event at all.
// The InputManager has its own threshold on top, but this is a pre-filter.
const MIN_CONFIDENCE = 0.55;

// ─── Hand-proximity tuning ────────────────────────────────────────────────────
// Hand "scale" = diagonal of the 21-landmark bounding box in normalised image
// coords (0..1). Empirically: ~0.22 when the hand is far from the camera,
// ~0.65+ when the hand fills the frame. We map this onto a speed multiplier
// (small box → far → SLOW; big box → close → FAST), with an EMA to smooth out
// per-frame jitter from the landmark tracker.

const HAND_DIAG_FAR   = 0.22;   // → SPEED_SLOW
const HAND_DIAG_CLOSE = 0.62;   // → SPEED_FAST
const SPEED_SLOW      = 1.70;   // factor passed to engine.setSpeedFactor
const SPEED_FAST      = 0.55;
const SPEED_NEUTRAL   = 1.00;   // value drifted toward when no hand is visible

// EMA smoothing factor. Lower = smoother but laggier. 0.18 ≈ ~5-frame time
// constant at 30 fps, which feels responsive without buzzing.
const PROXIMITY_EMA_ALPHA = 0.18;

// When the hand is lost, drift the smoothed diag toward a "neutral" value at
// this rate per frame so the snake settles to its level-default speed rather
// than freezing whatever the last reading was.
const PROXIMITY_DECAY_ALPHA = 0.05;
const HAND_DIAG_NEUTRAL     = (HAND_DIAG_FAR + HAND_DIAG_CLOSE) / 2;

// ─── GestureDetector ─────────────────────────────────────────────────────────

export class GestureDetector {

  // ── Config ──────────────────────────────────────────────────────────────────
  #videoEl;
  #overlayCanvas;
  #overlayCtx;
  #debounceMs;
  #stabilityFrames;
  #showDebug;

  // ── MediaPipe ───────────────────────────────────────────────────────────────
  #hands  = null;
  #camera = null;

  // ── State ───────────────────────────────────────────────────────────────────
  #listeners          = [];
  #proximityListeners = [];
  #lastEmitTime       = 0;
  #stabilityBuffer    = [];   // last N classified directions
  #lastEmittedDir     = null; // direction of the most recently emitted event
  #frameCount         = 0;    // total frames processed (for debug)
  #isRunning          = false;

  // EMA-smoothed bounding-box diagonal of the hand (0..1 normalised). null until
  // the first hand is observed.
  #smoothedDiag       = null;

  // ── Diagnostics ─────────────────────────────────────────────────────────────
  #debugInfo = {
    direction:   null,
    confidence:  0,
    fingers:     [],   // [index, middle, ring, pinky] extended booleans
    magnitude:   0,
    axisDominance: 0,
    stable:      false,
    frameCount:  0,
  };

  /**
   * @param {object}           options
   * @param {HTMLVideoElement}  options.videoEl         Hidden <video> element for camera feed
   * @param {HTMLCanvasElement} [options.overlayCanvas] Canvas for debug drawing (optional)
   * @param {number}           [options.debounceMs=280] Min ms between emitted events
   * @param {number}           [options.stabilityFrames=2] Frames that must agree before emitting
   * @param {boolean}          [options.showDebug=true] Draw landmarks + labels on overlayCanvas
   */
  constructor({
    videoEl,
    overlayCanvas    = null,
    debounceMs       = DEBOUNCE_MS,
    stabilityFrames  = STABILITY_FRAMES,
    showDebug        = true,
  }) {
    this.#videoEl        = videoEl;
    this.#overlayCanvas  = overlayCanvas;
    this.#overlayCtx     = overlayCanvas?.getContext('2d') ?? null;
    this.#debounceMs     = debounceMs;
    this.#stabilityFrames = stabilityFrames;
    this.#showDebug      = showDebug;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Register a listener for GestureEvents.
   * @param {(event: import('./contracts.js').GestureEvent) => void} fn
   * @returns {this}
   */
  onGesture(fn) {
    this.#listeners.push(fn);
    return this;
  }

  /**
   * Register a listener for continuous hand-proximity updates. Fires every
   * processed frame (≈30 fps) — even when no discrete gesture is classified —
   * with a smoothed measure of how close the hand is to the camera.
   *
   *   {
   *     diag:        number,  // EMA-smoothed bbox diagonal, 0..1
   *     t:           number,  // normalised 0..1 (0 = far, 1 = close)
   *     speedFactor: number,  // ready to pass to engine.setSpeedFactor()
   *     handVisible: boolean, // true when a hand was seen this frame
   *   }
   *
   * @param {(info: object) => void} fn
   * @returns {this}
   */
  onProximity(fn) {
    this.#proximityListeners.push(fn);
    return this;
  }

  /**
   * Start the webcam and begin processing frames.
   * Requires MediaPipe CDN scripts to be loaded in index.html.
   * @returns {Promise<void>}
   */
  async start() {
    if (this.#isRunning) return;

    if (!window.Hands || !window.Camera) {
      throw new Error(
        '[GestureDetector] MediaPipe not loaded. ' +
        'Add the three CDN <script> tags to index.html before this module runs.'
      );
    }

    // ── MediaPipe Hands setup ────────────────────────────────────────────────
    this.#hands = new window.Hands({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`,
    });

    this.#hands.setOptions({
      maxNumHands:            1,      // we only care about the directing hand
      modelComplexity:        1,      // 0=lite, 1=full — full is better accuracy
      minDetectionConfidence: 0.65,   // initial hand detection threshold
      minTrackingConfidence:  0.55,   // per-frame tracking threshold
    });

    this.#hands.onResults((results) => this.#onFrame(results));

    // ── Camera setup ─────────────────────────────────────────────────────────
    this.#camera = new window.Camera(this.#videoEl, {
      onFrame: async () => {
        if (this.#hands) await this.#hands.send({ image: this.#videoEl });
      },
      width:  640,
      height: 480,
    });

    await this.#camera.start();
    this.#isRunning = true;
    console.log('[GestureDetector] Camera started ✓');
  }

  /** Stop the camera and MediaPipe processing. */
  stop() {
    this.#isRunning = false;
    this.#camera?.stop();
    this.#hands?.close();
    this.#hands  = null;
    this.#camera = null;
    this.#clearOverlay();
    console.log('[GestureDetector] Stopped');
  }

  /** Is the detector currently running? */
  get isRunning() { return this.#isRunning; }

  /**
   * Get current debug info (useful for building a debug UI panel).
   * @returns {object}
   */
  getDebugInfo() { return { ...this.#debugInfo }; }

  // ─── Frame Processing ─────────────────────────────────────────────────────

  #onFrame(results) {
    this.#frameCount++;
    this.#clearOverlay();

    // No hand detected — drift proximity toward neutral, then bail.
    if (!results.multiHandLandmarks?.length) {
      this.#stabilityBuffer = [];
      this.#debugInfo.direction = null;
      this.#debugInfo.stable    = false;
      this.#updateProximity(null);
      return;
    }

    const landmarks  = results.multiHandLandmarks[0];
    const handedness = results.multiHandedness?.[0]?.label ?? 'Right'; // 'Left' or 'Right'

    // Update the smoothed hand-proximity reading (every frame, gesture or not).
    this.#updateProximity(this.#computeHandDiag(landmarks));

    // Draw landmark skeleton onto overlay canvas
    if (this.#showDebug) {
      this.#drawLandmarks(landmarks, results.multiHandConnections?.[0]);
    }

    // Classify the current pose
    const { direction, confidence, meta } = this.#classify(landmarks, handedness);

    // Update debug info
    this.#debugInfo = {
      direction,
      confidence,
      fingers:      meta.fingers,
      magnitude:    meta.magnitude,
      axisDominance: meta.axisDominance,
      stable:       false,
      frameCount:   this.#frameCount,
    };

    if (this.#showDebug) this.#drawDebugOverlay();

    if (!direction || confidence < MIN_CONFIDENCE) {
      this.#stabilityBuffer = [];
      return;
    }

    // ── Temporal stability ───────────────────────────────────────────────────
    this.#stabilityBuffer.push(direction);
    if (this.#stabilityBuffer.length > this.#stabilityFrames) {
      this.#stabilityBuffer.shift();
    }

    // All frames in buffer must agree
    const allAgree = this.#stabilityBuffer.length === this.#stabilityFrames
                  && this.#stabilityBuffer.every(d => d === direction);

    if (!allAgree) return;

    this.#debugInfo.stable = true;

    // ── Debounce ─────────────────────────────────────────────────────────────
    const now = Date.now();
    if (now - this.#lastEmitTime < this.#debounceMs) return;

    // ── Emit ─────────────────────────────────────────────────────────────────
    this.#lastEmitTime   = now;
    this.#lastEmittedDir = direction;

    const event = createGestureEvent(direction, confidence, 'camera');
    this.#listeners.forEach(fn => fn(event));
  }

  // ─── Classification ───────────────────────────────────────────────────────

  /**
   * Full gesture classification pipeline.
   *
   * @param {Array<{x,y,z}>} lm        — 21 normalised landmarks
   * @param {'Left'|'Right'} handedness — MediaPipe's handedness label
   * @returns {{ direction: string|null, confidence: number, meta: object }}
   */
  #classify(lm, handedness) {
    // ── 1. Finger extension analysis ────────────────────────────────────────
    const fingers = this.#analyseFingers(lm);
    // fingers = { index, middle, ring, pinky } — true = extended

    // ── 2. Pointing check ────────────────────────────────────────────────────
    // We need index extended AND the other three mostly curled.
    // Allow middle to be slightly extended without penalty (natural pointing).
    const isPointing = fingers.index
                    && !fingers.ring
                    && !fingers.pinky;

    // ── 3. Direction vector: wrist → index tip ───────────────────────────────
    const wrist    = lm[LM.WRIST];
    const indexTip = lm[LM.INDEX_TIP];

    // MediaPipe x increases rightward, y increases downward (screen coords).
    // The camera feed is mirrored (scaleX(-1) in CSS), so we flip dx.
    let dx = -(indexTip.x - wrist.x); // flip for mirror
    let dy =  (indexTip.y - wrist.y); // y: positive = downward

    const magnitude = Math.sqrt(dx * dx + dy * dy);

    // ── 4. Magnitude gate ────────────────────────────────────────────────────
    if (magnitude < MIN_POINTING_MAGNITUDE) {
      return { direction: null, confidence: 0, meta: { fingers: Object.values(fingers), magnitude, axisDominance: 0 } };
    }

    // ── 5. Axis dominance ────────────────────────────────────────────────────
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const axisDominance = absDx > absDy
      ? absDx / absDy   // horizontal dominance
      : absDy / absDx;  // vertical dominance

    // Reject ambiguous diagonals
    if (axisDominance < AXIS_DOMINANCE_RATIO) {
      return { direction: null, confidence: 0, meta: { fingers: Object.values(fingers), magnitude, axisDominance } };
    }

    // ── 6. Determine direction ───────────────────────────────────────────────
    let direction;
    if (absDy > absDx) {
      direction = dy < 0 ? 'UP' : 'DOWN';
    } else {
      direction = dx > 0 ? 'RIGHT' : 'LEFT';
    }

    // ── 7. Confidence score ──────────────────────────────────────────────────
    // Blend: magnitude contribution + axis clarity + finger state bonus
    const magnitudeScore = Math.min(1, magnitude / 0.35);       // 0–1
    const axisScore      = Math.min(1, (axisDominance - 1) / 3); // 0–1
    const fingerBonus    = isPointing ? 0.15 : -0.1;

    const confidence = Math.max(0, Math.min(1,
      magnitudeScore * 0.55 +
      axisScore      * 0.30 +
      0.15           +        // base
      fingerBonus
    ));

    return {
      direction,
      confidence,
      meta: {
        fingers: [fingers.index, fingers.middle, fingers.ring, fingers.pinky],
        magnitude,
        axisDominance,
      },
    };
  }

  /**
   * Determine which fingers are extended using PIP-to-TIP distance vs wrist distance.
   *
   * A finger is considered extended if its tip is farther from the wrist than
   * its PIP (proximal interphalangeal) joint, scaled by a curl threshold.
   *
   * @param {Array<{x,y,z}>} lm
   * @returns {{ index: boolean, middle: boolean, ring: boolean, pinky: boolean }}
   */
  #analyseFingers(lm) {
    return {
      index:  this.#isFingerExtended(lm, LM.INDEX_PIP,  LM.INDEX_TIP),
      middle: this.#isFingerExtended(lm, LM.MIDDLE_PIP, LM.MIDDLE_TIP),
      ring:   this.#isFingerExtended(lm, LM.RING_PIP,   LM.RING_TIP),
      pinky:  this.#isFingerExtended(lm, LM.PINKY_PIP,  LM.PINKY_TIP),
    };
  }

  /**
   * A finger is extended when:
   *   dist(wrist, tip) > dist(wrist, pip) * CURL_THRESHOLD
   *
   * This works regardless of hand rotation and camera angle.
   */
  #isFingerExtended(lm, pipIdx, tipIdx) {
    const wristToTip = this.#dist(lm[LM.WRIST], lm[tipIdx]);
    const wristToPip = this.#dist(lm[LM.WRIST], lm[pipIdx]);
    return wristToTip > wristToPip * CURL_THRESHOLD;
  }

  #dist(a, b) {
    return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
  }

  // ─── Hand proximity ───────────────────────────────────────────────────────

  /**
   * Diagonal of the axis-aligned bounding box of all 21 landmarks, in
   * normalised image coords. Robust to which way the hand is oriented because
   * the bbox captures the full reach of the hand, fingers included.
   */
  #computeHandDiag(landmarks) {
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const lm of landmarks) {
      if (lm.x < minX) minX = lm.x;
      if (lm.y < minY) minY = lm.y;
      if (lm.x > maxX) maxX = lm.x;
      if (lm.y > maxY) maxY = lm.y;
    }
    const w = maxX - minX, h = maxY - minY;
    return Math.sqrt(w * w + h * h);
  }

  /**
   * Update the EMA-smoothed proximity reading and fire listeners.
   * @param {number|null} rawDiag  this-frame bbox diagonal, or null if no hand
   */
  #updateProximity(rawDiag) {
    if (rawDiag !== null) {
      // Hand present: EMA toward the new reading.
      this.#smoothedDiag = this.#smoothedDiag === null
        ? rawDiag
        : this.#smoothedDiag + (rawDiag - this.#smoothedDiag) * PROXIMITY_EMA_ALPHA;
    } else if (this.#smoothedDiag !== null) {
      // No hand: drift gently back toward neutral so the snake doesn't get
      // stuck at whatever speed the user left it at.
      this.#smoothedDiag = this.#smoothedDiag
        + (HAND_DIAG_NEUTRAL - this.#smoothedDiag) * PROXIMITY_DECAY_ALPHA;
    } else {
      return; // never seen a hand yet — nothing to emit
    }

    const range = HAND_DIAG_CLOSE - HAND_DIAG_FAR;
    const t = Math.max(0, Math.min(1, (this.#smoothedDiag - HAND_DIAG_FAR) / range));
    // t=0 (far) → SPEED_SLOW;  t=1 (close) → SPEED_FAST
    const speedFactor = SPEED_SLOW + (SPEED_FAST - SPEED_SLOW) * t;

    const info = {
      diag:        this.#smoothedDiag,
      t,
      speedFactor,
      handVisible: rawDiag !== null,
    };

    // Stash on debug info so the existing 10 fps debug poll can read it.
    this.#debugInfo.handDiag    = this.#smoothedDiag;
    this.#debugInfo.proximityT  = t;
    this.#debugInfo.speedFactor = speedFactor;

    for (const fn of this.#proximityListeners) fn(info);
  }

  // ─── Debug Overlay ────────────────────────────────────────────────────────

  #clearOverlay() {
    if (!this.#overlayCtx) return;
    this.#overlayCtx.clearRect(
      0, 0,
      this.#overlayCanvas.width,
      this.#overlayCanvas.height
    );
  }

  #drawLandmarks(landmarks, connections) {
    const ctx = this.#overlayCtx;
    if (!ctx) return;

    // The overlay canvas is NOT CSS-mirrored (so text stays readable), but the
    // video underneath IS mirrored. Pre-mirror the landmarks here so the skeleton
    // still lines up with the user's hand on screen.
    const mirrored = landmarks.map(l => ({ x: 1 - l.x, y: l.y, z: l.z }));

    // Connections (skeleton lines)
    if (window.drawConnectors && connections) {
      window.drawConnectors(ctx, mirrored, connections, {
        color: 'rgba(0,255,136,0.7)',
        lineWidth: 2,
      });
    }

    // Landmark dots
    if (window.drawLandmarks) {
      window.drawLandmarks(ctx, mirrored, {
        color:     '#ff3355',
        fillColor: 'rgba(255,51,85,0.5)',
        lineWidth: 1,
        radius:    3,
      });
    }

    // Highlight index tip in a distinct colour
    const tip = landmarks[LM.INDEX_TIP];
    if (tip) {
      const x = (1 - tip.x) * this.#overlayCanvas.width;
      const y = tip.y * this.#overlayCanvas.height;
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fillStyle   = 'rgba(0,238,255,0.8)';
      ctx.strokeStyle = '#fff';
      ctx.lineWidth   = 1.5;
      ctx.fill();
      ctx.stroke();
    }
  }

  #drawDebugOverlay() {
    const ctx = this.#overlayCtx;
    if (!ctx || !this.#overlayCanvas) return;

    const { direction, confidence, stable, fingers, magnitude, axisDominance } = this.#debugInfo;

    const W = this.#overlayCanvas.width;
    const H = this.#overlayCanvas.height;

    // ── Direction badge ──────────────────────────────────────────────────────
    if (direction) {
      const arrows = { UP: '↑', DOWN: '↓', LEFT: '←', RIGHT: '→' };
      const color  = stable ? '#00ff88' : '#ffd700';
      const label  = `${arrows[direction]} ${direction}`;
      const conf   = `${(confidence * 100).toFixed(0)}%`;

      // Background pill
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.beginPath();
      ctx.roundRect?.(8, 8, 130, 52, 6) ?? ctx.rect(8, 8, 130, 52);
      ctx.fill();

      // Direction text
      ctx.font      = 'bold 22px "Courier New", monospace';
      ctx.fillStyle = color;
      ctx.fillText(label, 16, 32);

      // Confidence + stable indicator
      ctx.font      = '12px "Courier New", monospace';
      ctx.fillStyle = stable ? '#00ff88' : 'rgba(255,255,255,0.5)';
      ctx.fillText(`${conf} ${stable ? '✓ LOCKED' : '...'}`, 16, 50);
    }

    // ── Finger state bar ─────────────────────────────────────────────────────
    if (fingers?.length) {
      const names  = ['IDX', 'MID', 'RNG', 'PNK'];
      const startX = W - 10 - names.length * 36;
      const startY = 12;

      fingers.forEach((extended, i) => {
        const x = startX + i * 36;
        ctx.fillStyle = extended ? 'rgba(0,255,136,0.85)' : 'rgba(255,51,85,0.5)';
        ctx.fillRect(x, startY, 30, 14);
        ctx.fillStyle = '#fff';
        ctx.font      = '9px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(names[i], x + 15, startY + 10);
        ctx.textAlign = 'left';
      });
    }

    // ── Mini stats ───────────────────────────────────────────────────────────
    ctx.fillStyle = 'rgba(255,255,255,0.25)';
    ctx.font      = '10px monospace';
    ctx.fillText(`mag: ${magnitude.toFixed(3)}  axis: ${axisDominance.toFixed(2)}`, 10, H - 8);
  }
}
