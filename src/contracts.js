/**
 * contracts.js — Member 1
 *
 * The single source of truth for every data shape passed between modules.
 * All four members import from here. NOBODY modifies this file without
 * full group agreement — changes here break everyone.
 *
 * Exports:
 *   DIRECTIONS           — {UP,DOWN,LEFT,RIGHT} → {x,y} delta objects
 *   DIRECTION_KEYS       — ['UP','DOWN','LEFT','RIGHT']
 *   OPPOSITE_DIRECTION   — map from direction → its opposite
 *   GAME_STATUS          — {IDLE, RUNNING, PAUSED, GAME_OVER}
 *   GRID                 — {COLS, ROWS, CELL_SIZE}
 *   isOppositeDirection  — (a, b) => boolean
 *   isValidDirection     — (s) => boolean
 *   createGestureEvent   — (direction, confidence?) => GestureEvent
 *   createGameState      — (overrides?) => GameState
 *   assertGestureEvent   — throws if shape is wrong (dev-time validation)
 *   assertGameState      — throws if shape is wrong (dev-time validation)
 */

// ─── Directions ───────────────────────────────────────────────────────────────

export const DIRECTIONS = Object.freeze({
  UP:    Object.freeze({ x:  0, y: -1 }),
  DOWN:  Object.freeze({ x:  0, y:  1 }),
  LEFT:  Object.freeze({ x: -1, y:  0 }),
  RIGHT: Object.freeze({ x:  1, y:  0 }),
});

export const DIRECTION_KEYS = Object.freeze(['UP', 'DOWN', 'LEFT', 'RIGHT']);

/** Pre-computed opposite for each direction — avoids recomputing each tick */
export const OPPOSITE_DIRECTION = Object.freeze({
  UP:    'DOWN',
  DOWN:  'UP',
  LEFT:  'RIGHT',
  RIGHT: 'LEFT',
});

/** True if `direction` is a valid direction string */
export function isValidDirection(direction) {
  return DIRECTION_KEYS.includes(direction);
}

/** True if turning from direction `a` to direction `b` would be a 180° reversal */
export function isOppositeDirection(a, b) {
  return OPPOSITE_DIRECTION[a] === b;
}

// ─── Game Status ──────────────────────────────────────────────────────────────

export const GAME_STATUS = Object.freeze({
  IDLE:      'IDLE',
  RUNNING:   'RUNNING',
  PAUSED:    'PAUSED',
  GAME_OVER: 'GAME_OVER',
});

export const GAME_STATUS_KEYS = Object.freeze(Object.keys(GAME_STATUS));

// ─── Grid ─────────────────────────────────────────────────────────────────────

export const GRID = Object.freeze({
  COLS:      20,
  ROWS:      20,
  CELL_SIZE: 28, // pixels — only the renderer uses this
});

// ─── GestureEvent ─────────────────────────────────────────────────────────────

/**
 * @typedef {Object} GestureEvent
 * @property {'UP'|'DOWN'|'LEFT'|'RIGHT'} direction
 * @property {number} confidence  — float 0.0–1.0
 * @property {number} timestamp   — Date.now() ms
 * @property {'camera'|'keyboard'|'mock'} source  — where this event came from
 */

/**
 * Create a validated, frozen GestureEvent.
 * Member 2 (camera) and Member 1 (mock/keyboard) both use this.
 *
 * @param {'UP'|'DOWN'|'LEFT'|'RIGHT'} direction
 * @param {number} [confidence=1.0]
 * @param {'camera'|'keyboard'|'mock'} [source='camera']
 * @returns {GestureEvent}
 */
export function createGestureEvent(direction, confidence = 1.0, source = 'camera') {
  if (!isValidDirection(direction)) {
    throw new Error(`[contracts] Invalid direction "${direction}". Must be one of: ${DIRECTION_KEYS.join(', ')}`);
  }
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    throw new RangeError(`[contracts] confidence must be 0.0–1.0, got ${confidence}`);
  }
  return Object.freeze({
    direction,
    confidence: Math.round(confidence * 1000) / 1000, // 3 decimal places
    timestamp:  Date.now(),
    source,
  });
}

/**
 * Validate a GestureEvent at runtime.
 * Throws a descriptive error if the shape is wrong.
 * Use in dev/test — strip from production builds if perf matters.
 * @param {unknown} event
 * @returns {GestureEvent}
 */
export function assertGestureEvent(event) {
  if (!event || typeof event !== 'object') throw new TypeError('[contracts] GestureEvent must be an object');
  if (!isValidDirection(event.direction))  throw new TypeError(`[contracts] GestureEvent.direction invalid: ${event.direction}`);
  if (typeof event.confidence !== 'number') throw new TypeError('[contracts] GestureEvent.confidence must be a number');
  if (typeof event.timestamp  !== 'number') throw new TypeError('[contracts] GestureEvent.timestamp must be a number');
  return event;
}

// ─── GameState ────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} GameState
 * @property {GAME_STATUS} status
 * @property {Array<{x:number,y:number}>} snake  — head is index 0
 * @property {{x:number,y:number}} food
 * @property {'UP'|'DOWN'|'LEFT'|'RIGHT'} direction
 * @property {number} score
 * @property {number} tick          — increments every engine step
 * @property {number} level         — 1–10
 * @property {number} combo         — current streak count
 * @property {number} multiplier    — active score multiplier (1 or 2)
 * @property {object|null} boardPowerUp  — { type, x, y, ticksLeft } | null
 * @property {string[]} activeEffects   — active POWERUP_TYPE keys
 * @property {number} highScore
 */

/**
 * Create a validated, frozen GameState snapshot.
 * The engine calls this; the renderer and UI read it.
 * @param {Partial<GameState>} [overrides={}]
 * @returns {GameState}
 */
export function createGameState(overrides = {}) {
  return Object.freeze({
    status:        GAME_STATUS.IDLE,
    snake:         Object.freeze([Object.freeze({ x: 10, y: 10 })]),
    food:          Object.freeze({ x: 5, y: 5 }),
    direction:     'RIGHT',
    score:         0,
    tick:          0,
    level:         1,
    combo:         0,
    multiplier:    1,
    boardPowerUp:  null,
    activeEffects: Object.freeze([]),
    highScore:     0,
    ...overrides,
  });
}

/**
 * Validate a GameState object at runtime.
 * @param {unknown} state
 * @returns {GameState}
 */
export function assertGameState(state) {
  if (!state || typeof state !== 'object')       throw new TypeError('[contracts] GameState must be an object');
  if (!GAME_STATUS_KEYS.includes(state.status))  throw new TypeError(`[contracts] GameState.status invalid: ${state.status}`);
  if (!Array.isArray(state.snake))               throw new TypeError('[contracts] GameState.snake must be an array');
  if (state.snake.length === 0)                  throw new RangeError('[contracts] GameState.snake must not be empty');
  if (!isValidDirection(state.direction))        throw new TypeError(`[contracts] GameState.direction invalid: ${state.direction}`);
  if (typeof state.score !== 'number')           throw new TypeError('[contracts] GameState.score must be a number');
  if (typeof state.tick  !== 'number')           throw new TypeError('[contracts] GameState.tick must be a number');
  return state;
}
