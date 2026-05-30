/**
 * game-engine.js — Member 3
 *
 * Pure game logic. Zero DOM, zero canvas, zero camera.
 *
 * Features:
 *  - Buffered input queue (up to 2 moves ahead — no missed gestures)
 *  - Smooth speed curve tied to level progression
 *  - Combo multiplier (eat quickly in a row = more points)
 *  - Power-ups: SHIELD (absorb one hit), SLOW (half speed), MULTIPLIER (2× score)
 *  - High score persisted to localStorage
 *  - Rich event system: onStateChange + named event hooks
 *  - Exhaustive food spawner (handles nearly-full board)
 *
 * Public API:
 *   engine.onStateChange(fn)   — fires every tick with full GameState
 *   engine.on(event, fn)       — subscribe to named events (see EVENTS export)
 *   engine.start()
 *   engine.pause()
 *   engine.resume()
 *   engine.reset()
 *   engine.setDirection(dir)   — called by InputManager
 *   engine.getState()          — synchronous read-only snapshot
 *   engine.getStats()          — session stats object
 */

import {
  DIRECTIONS,
  GAME_STATUS,
  GRID,
  createGameState,
} from './contracts.js';

// ─── Public Constants (importable by renderer/UI) ─────────────────────────────

/** Named events emitted by the engine. Use with engine.on(EVENTS.X, fn). */
export const EVENTS = Object.freeze({
  FOOD_EATEN:    'food_eaten',    // { score, earned, combo, multiplier }
  POWERUP_SPAWN: 'powerup_spawn', // { powerUp: { type, x, y } }
  POWERUP_GRAB:  'powerup_grab',  // { type, duration }
  POWERUP_END:   'powerup_end',   // { type }
  LEVEL_UP:      'level_up',      // { level, intervalMs }
  GAME_OVER:     'game_over',     // { score, highScore, isNewRecord, stats }
  SHIELD_HIT:    'shield_hit',    // {} — shield saved the player
});

/** Power-up type identifiers */
export const POWERUP_TYPE = Object.freeze({
  SHIELD:     'SHIELD',      // absorb one collision (wall or self)
  SLOW:       'SLOW',        // halve tick speed for 5 s
  MULTIPLIER: 'MULTIPLIER',  // 2× point value for 8 s
});

// ─── Internal Config ──────────────────────────────────────────────────────────

// How long (ms) timed power-ups last on the board
const EFFECT_DURATION_MS = Object.freeze({
  [POWERUP_TYPE.SHIELD]:     0,     // instant — consumed on hit, no timer
  [POWERUP_TYPE.SLOW]:       5000,
  [POWERUP_TYPE.MULTIPLIER]: 8000,
});

// Points per food (before combo/multiplier)
const BASE_FOOD_SCORE = 10;

// Combo: ticks within which consecutive eats count as a streak
const COMBO_WINDOW_TICKS = 6;
const COMBO_BONUS_PER_STREAK = 5; // extra points per combo level
const MAX_COMBO = 8;

// Score thresholds to reach each level (index = level number, 1-based)
const LEVEL_THRESHOLDS = [0, 0, 50, 150, 300, 500, 750, 1050, 1400, 1800, 2250];

// Tick interval (ms) at each level — smaller = faster
const LEVEL_SPEEDS = [null, 180, 158, 138, 118, 102, 90, 79, 69, 61, 53];

// Probability a power-up spawns after eating food (no power-up currently on board)
const POWERUP_SPAWN_CHANCE = 0.25;

// Ticks a power-up stays on the board before despawning
const POWERUP_LINGER_TICKS = 30;

// Maximum directions buffered ahead of current tick
const MAX_INPUT_QUEUE = 2;

// Allowed range for the external speed multiplier (hand-proximity, etc).
// Clamped on input so a wild CV reading can never grind the game to a halt
// or make it unsurvivably fast.
const SPEED_FACTOR_MIN = 0.45;  // up to ~2.2× the level's default speed
const SPEED_FACTOR_MAX = 2.00;  // down to half the level's default speed

const HIGH_SCORE_KEY = 'snake_high_score';

// ─── GameEngine Class ─────────────────────────────────────────────────────────

export class GameEngine {

  // ── Core ────────────────────────────────────────────────────────────────────
  #state            = createGameState();
  #tickId           = null;
  #stateListeners   = [];
  #eventBus         = {};   // event name → [callbacks]

  // ── Input buffer ────────────────────────────────────────────────────────────
  #inputQueue = [];   // ['UP', 'LEFT', …] — max MAX_INPUT_QUEUE entries

  // ── Progression ─────────────────────────────────────────────────────────────
  #level            = 1;
  #combo            = 0;
  #ticksSinceEat    = 0;

  // ── External speed scaling (e.g. hand-proximity multiplier) ────────────────
  // 1.0 = level-default. <1.0 = faster, >1.0 = slower. Clamped on input.
  #speedFactor      = 1.0;

  // ── Power-ups ────────────────────────────────────────────────────────────────
  /** Board item: { type, x, y, ticksLeft } | null */
  #boardPowerUp     = null;
  /** Active effects: Map<POWERUP_TYPE, { expiresAt: ms (0 = no expiry) }> */
  #activeEffects    = new Map();

  // ── Session stats ────────────────────────────────────────────────────────────
  #stats = {
    gamesPlayed:     0,
    totalScore:      0,
    longestSnake:    0,
    powerUpsGrabbed: 0,
    highScore:       this.#loadHighScore(),
  };

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Subscribe to every state update (fires each tick and on status changes).
   * @param {(state: import('./contracts.js').GameState) => void} fn
   * @returns {this} for chaining
   */
  onStateChange(fn) {
    this.#stateListeners.push(fn);
    return this;
  }

  /**
   * Subscribe to a specific named engine event.
   * @param {string} event  - one of EVENTS.*
   * @param {(payload: object) => void} fn
   * @returns {this} for chaining
   */
  on(event, fn) {
    (this.#eventBus[event] ??= []).push(fn);
    return this;
  }

  start() {
    if (this.#state.status === GAME_STATUS.RUNNING) return;

    if (
      this.#state.status === GAME_STATUS.IDLE ||
      this.#state.status === GAME_STATUS.GAME_OVER
    ) {
      this.#initState();
    }

    this.#setState({ status: GAME_STATUS.RUNNING });
    this.#scheduleTick();
  }

  pause() {
    if (this.#state.status !== GAME_STATUS.RUNNING) return;
    this.#clearTick();
    this.#setState({ status: GAME_STATUS.PAUSED });
  }

  resume() {
    if (this.#state.status !== GAME_STATUS.PAUSED) return;
    this.#setState({ status: GAME_STATUS.RUNNING });
    this.#scheduleTick();
  }

  reset() {
    this.#clearTick();
    this.#initState();
  }

  /**
   * Queue a direction change from the InputManager.
   * Up to MAX_INPUT_QUEUE moves are buffered so rapid gestures aren't dropped.
   * Reversal validation happens against the last queued direction.
   * @param {'UP'|'DOWN'|'LEFT'|'RIGHT'} direction
   */
  setDirection(direction) {
    if (this.#inputQueue.length >= MAX_INPUT_QUEUE) return;

    const reference = this.#inputQueue.at(-1) ?? this.#state.direction;
    if (!this.#isLegalTurn(direction, reference)) return;

    this.#inputQueue.push(direction);
  }

  /** @returns {import('./contracts.js').GameState} */
  getState() {
    return this.#state;
  }

  /** @returns {object} session-wide stats */
  getStats() {
    return { ...this.#stats };
  }

  /**
   * Set an external speed multiplier (e.g. driven by hand proximity to camera).
   * `factor < 1` speeds the snake up, `factor > 1` slows it down. Clamped to
   * [SPEED_FACTOR_MIN, SPEED_FACTOR_MAX] so noisy CV can't make the game
   * unplayable. Takes effect on the next scheduled tick.
   * @param {number} factor
   */
  setSpeedFactor(factor) {
    if (!Number.isFinite(factor)) return;
    this.#speedFactor = Math.max(SPEED_FACTOR_MIN, Math.min(SPEED_FACTOR_MAX, factor));
  }

  /** Current speed multiplier (clamped). */
  getSpeedFactor() {
    return this.#speedFactor;
  }

  // ─── Initialisation ───────────────────────────────────────────────────────────

  #initState() {
    const cx = Math.floor(GRID.COLS / 2);
    const cy = Math.floor(GRID.ROWS / 2);

    this.#level         = 1;
    this.#combo         = 0;
    this.#ticksSinceEat = 0;
    this.#boardPowerUp  = null;
    this.#inputQueue    = [];
    this.#activeEffects.clear();

    const snake = [
      { x: cx,     y: cy },
      { x: cx - 1, y: cy },
      { x: cx - 2, y: cy },
    ];

    this.#state = createGameState({
      status:        GAME_STATUS.IDLE,
      snake,
      food:          this.#spawnFood(snake),
      direction:     'RIGHT',
      score:         0,
      tick:          0,
      // Extended fields — contracts.js allows extra keys via spread
      level:         1,
      combo:         0,
      multiplier:    1,
      boardPowerUp:  null,
      activeEffects: [],
      highScore:     this.#stats.highScore,
    });

    this.#emitState();
  }

  // ─── Game Loop ────────────────────────────────────────────────────────────────

  #scheduleTick() {
    this.#clearTick();
    this.#tickId = setTimeout(() => {
      this.#tick();
      if (this.#state.status === GAME_STATUS.RUNNING) {
        this.#scheduleTick(); // reschedule (interval may have changed due to SLOW)
      }
    }, this.#tickIntervalMs());
  }

  #clearTick() {
    if (this.#tickId !== null) {
      clearTimeout(this.#tickId);
      this.#tickId = null;
    }
  }

  #tickIntervalMs() {
    const base   = LEVEL_SPEEDS[Math.min(this.#level, LEVEL_SPEEDS.length - 1)];
    const slowed = this.#hasEffect(POWERUP_TYPE.SLOW) ? base * 2 : base;
    return slowed * this.#speedFactor;
  }

  // ─── Tick ────────────────────────────────────────────────────────────────────

  #tick() {
    const { snake, food } = this.#state;

    // 1. Consume next buffered direction (or hold current)
    const nextDir = this.#inputQueue.shift() ?? this.#state.direction;
    const delta   = DIRECTIONS[nextDir];
    const newHead = { x: snake[0].x + delta.x, y: snake[0].y + delta.y };

    // 2. Collision detection
    const wallHit = newHead.x < 0 || newHead.x >= GRID.COLS
                 || newHead.y < 0 || newHead.y >= GRID.ROWS;
    const selfHit = snake.some(s => s.x === newHead.x && s.y === newHead.y);

    if (wallHit || selfHit) {
      if (this.#hasEffect(POWERUP_TYPE.SHIELD)) {
        // Shield absorbs the hit — wrap around and deactivate
        this.#deactivateEffect(POWERUP_TYPE.SHIELD);
        this.#fireEvent(EVENTS.SHIELD_HIT, {});
        newHead.x = ((newHead.x % GRID.COLS) + GRID.COLS) % GRID.COLS;
        newHead.y = ((newHead.y % GRID.ROWS) + GRID.ROWS) % GRID.ROWS;
        // If after wrap we're still inside the snake body, it's game over
        if (snake.slice(0, -1).some(s => s.x === newHead.x && s.y === newHead.y)) {
          return this.#triggerGameOver();
        }
      } else {
        return this.#triggerGameOver();
      }
    }

    // 3. Ate food?
    const ateFood = newHead.x === food.x && newHead.y === food.y;

    // 4. Ate board power-up?
    const atePowerUp = this.#boardPowerUp
      && newHead.x === this.#boardPowerUp.x
      && newHead.y === this.#boardPowerUp.y;

    // 5. Advance snake body
    const newSnake = [newHead, ...snake];
    if (!ateFood) newSnake.pop(); // grow only when food eaten

    // 6. Scoring & combo
    let newScore = this.#state.score;
    let newFood  = food;

    this.#ticksSinceEat++;

    if (ateFood) {
      const inWindow = this.#ticksSinceEat <= COMBO_WINDOW_TICKS;
      this.#combo      = inWindow ? Math.min(this.#combo + 1, MAX_COMBO) : 1;
      this.#ticksSinceEat = 0;

      const comboBonus  = (this.#combo - 1) * COMBO_BONUS_PER_STREAK;
      const basePoints  = BASE_FOOD_SCORE + comboBonus;
      const multiplier  = this.#hasEffect(POWERUP_TYPE.MULTIPLIER) ? 2 : 1;
      const earned      = basePoints * multiplier;

      newScore += earned;
      newFood   = this.#spawnFood(newSnake);

      this.#fireEvent(EVENTS.FOOD_EATEN, {
        score: newScore, earned, combo: this.#combo, multiplier,
      });

      // Maybe spawn a power-up on the board
      if (!this.#boardPowerUp && Math.random() < POWERUP_SPAWN_CHANCE) {
        this.#doSpawnPowerUp(newSnake, newFood);
      }

      // Level up?
      const newLevel = this.#scoreToLevel(newScore);
      if (newLevel > this.#level) {
        this.#level = newLevel;
        this.#fireEvent(EVENTS.LEVEL_UP, {
          level: this.#level,
          intervalMs: this.#tickIntervalMs(),
        });
      }
    } else if (this.#ticksSinceEat > COMBO_WINDOW_TICKS) {
      this.#combo = 0;
    }

    // 7. Power-up pickup / ageing
    let newBoardPowerUp = this.#boardPowerUp;

    if (atePowerUp) {
      this.#activateEffect(this.#boardPowerUp.type);
      this.#boardPowerUp = null;
      newBoardPowerUp    = null;
      this.#stats.powerUpsGrabbed++;
    } else if (this.#boardPowerUp) {
      const aged = { ...this.#boardPowerUp, ticksLeft: this.#boardPowerUp.ticksLeft - 1 };
      this.#boardPowerUp = aged.ticksLeft > 0 ? aged : null;
      newBoardPowerUp    = this.#boardPowerUp;
    }

    // 8. Expire timed active effects
    const now = Date.now();
    for (const [type, { expiresAt }] of this.#activeEffects) {
      if (expiresAt > 0 && now >= expiresAt) {
        this.#deactivateEffect(type);
      }
    }

    // 9. Track session stats
    if (newSnake.length > this.#stats.longestSnake) {
      this.#stats.longestSnake = newSnake.length;
    }

    // 10. Push new state
    this.#setState({
      snake:         newSnake,
      food:          newFood,
      direction:     nextDir,
      score:         newScore,
      tick:          this.#state.tick + 1,
      level:         this.#level,
      combo:         this.#combo,
      multiplier:    this.#hasEffect(POWERUP_TYPE.MULTIPLIER) ? 2 : 1,
      boardPowerUp:  newBoardPowerUp,
      activeEffects: [...this.#activeEffects.keys()],
    });
  }

  // ─── Game Over ────────────────────────────────────────────────────────────────

  #triggerGameOver() {
    this.#clearTick();

    const score     = this.#state.score;
    const isRecord  = score > this.#stats.highScore;
    if (isRecord) {
      this.#stats.highScore = score;
      this.#saveHighScore(score);
    }

    this.#stats.gamesPlayed++;
    this.#stats.totalScore += score;

    this.#setState({
      status:    GAME_STATUS.GAME_OVER,
      highScore: this.#stats.highScore,
    });

    this.#fireEvent(EVENTS.GAME_OVER, {
      score,
      highScore:   this.#stats.highScore,
      isNewRecord: isRecord,
      stats:       this.getStats(),
    });
  }

  // ─── Power-ups ────────────────────────────────────────────────────────────────

  #doSpawnPowerUp(snake, food) {
    const types = Object.values(POWERUP_TYPE);
    const type  = types[Math.floor(Math.random() * types.length)];
    // Use #spawnFood to find a cell not occupied by snake or food
    const pos   = this.#spawnFood([...snake, food]);

    this.#boardPowerUp = { type, x: pos.x, y: pos.y, ticksLeft: POWERUP_LINGER_TICKS };
    this.#fireEvent(EVENTS.POWERUP_SPAWN, { powerUp: { ...this.#boardPowerUp } });
  }

  #activateEffect(type) {
    const duration  = EFFECT_DURATION_MS[type] ?? 0;
    const expiresAt = duration > 0 ? Date.now() + duration : 0;
    this.#activeEffects.set(type, { expiresAt });
    this.#fireEvent(EVENTS.POWERUP_GRAB, { type, duration });
  }

  #deactivateEffect(type) {
    this.#activeEffects.delete(type);
    this.#fireEvent(EVENTS.POWERUP_END, { type });
  }

  #hasEffect(type) {
    return this.#activeEffects.has(type);
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * Spawn a position not occupied by anything in `occupied`.
   * Uses fast random attempts, then exhaustive fallback for nearly-full boards.
   */
  #spawnFood(occupied) {
    const taken = new Set(occupied.map(c => `${c.x},${c.y}`));
    const total = GRID.COLS * GRID.ROWS;

    if (taken.size >= total) return occupied[0]; // board full — edge case

    // Fast path
    for (let i = 0; i < 80; i++) {
      const x = Math.floor(Math.random() * GRID.COLS);
      const y = Math.floor(Math.random() * GRID.ROWS);
      if (!taken.has(`${x},${y}`)) return { x, y };
    }

    // Exhaustive fallback (for boards > ~80% full)
    const free = [];
    for (let y = 0; y < GRID.ROWS; y++)
      for (let x = 0; x < GRID.COLS; x++)
        if (!taken.has(`${x},${y}`)) free.push({ x, y });

    return free[Math.floor(Math.random() * free.length)];
  }

  /** True if turning from `current` to `next` is physically legal */
  #isLegalTurn(next, current) {
    if (next === current) return false;
    const a = DIRECTIONS[next];
    const b = DIRECTIONS[current];
    return !(a.x === -b.x && a.y === -b.y);
  }

  /** Map a score to the appropriate level number */
  #scoreToLevel(score) {
    let level = 1;
    for (let i = LEVEL_THRESHOLDS.length - 1; i >= 1; i--) {
      if (score >= LEVEL_THRESHOLDS[i]) {
        level = i;
        break;
      }
    }
    return Math.min(level, LEVEL_SPEEDS.length - 1);
  }

  // ─── State management ─────────────────────────────────────────────────────────

  #setState(partial) {
    this.#state = Object.freeze({ ...this.#state, ...partial });
    this.#emitState();
  }

  #emitState() {
    for (const fn of this.#stateListeners) fn(this.#state);
  }

  #fireEvent(name, payload) {
    const handlers = this.#eventBus[name];
    if (!handlers) return;
    for (const fn of handlers) fn(payload);
  }

  // ─── Persistence ─────────────────────────────────────────────────────────────

  #loadHighScore() {
    try { return parseInt(localStorage.getItem(HIGH_SCORE_KEY) ?? '0', 10) || 0; }
    catch { return 0; }
  }

  #saveHighScore(score) {
    try { localStorage.setItem(HIGH_SCORE_KEY, String(score)); }
    catch { /* private browsing — silently ignore */ }
  }
}
