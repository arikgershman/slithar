/**
 * renderer.js — Member 4
 *
 * Reads GameState every tick and draws everything to the game canvas.
 * Zero game logic here — purely visual.
 *
 * Features:
 *  - Smooth snake interpolation between ticks
 *  - Animated food (pulsing glow)
 *  - Power-up board item with rotating ring + icon
 *  - Power-up board item despawn warning (flashes when ticksLeft < 10)
 *  - Shield effect: cyan tint on snake head + aura
 *  - Multiplier effect: gold tint on snake
 *  - Slow effect: blue-tinted snake + speed lines
 *  - Combo flash: brief bright overlay on food eat
 *  - Particle system: sparks on food eat, shield hit
 *  - Floating score popups (+10, ×2 COMBO, etc.)
 *  - Direction-aware snake eyes
 *  - Overlay screens: IDLE, PAUSED, GAME_OVER (with high score)
 *  - Public notify*() methods called by main.js on engine events
 */

import { GRID, GAME_STATUS } from './contracts.js';
import { POWERUP_TYPE }      from './game-engine.js';

const C = GRID.CELL_SIZE; // px per cell

// ─── Palette ──────────────────────────────────────────────────────────────────
const P = {
  bg:           '#08080e',
  gridLine:     'rgba(255,255,255,0.03)',
  snakeHead:    '#00ff88',
  snakeBody:    '#00cc66',
  snakeDark:    '#004422',
  food:         '#ff3355',
  foodGlow:     'rgba(255,51,85,0.5)',
  shield:       '#00eeff',
  shieldGlow:   'rgba(0,238,255,0.35)',
  multiplier:   '#ffd700',
  multiplierGl: 'rgba(255,215,0,0.3)',
  slow:         '#7788ff',
  slowGlow:     'rgba(119,136,255,0.3)',
  overlayBg:    'rgba(8,8,14,0.88)',
  accent:       '#00ff88',
  danger:       '#ff3355',
  white:        '#ffffff',
  muted:        'rgba(255,255,255,0.35)',
};

// ─── Renderer ─────────────────────────────────────────────────────────────────
export class Renderer {
  #canvas;
  #ctx;
  #state      = null;
  #particles  = [];   // { x, y, vx, vy, life, maxLife, color, r }
  #popups     = [];   // { x, y, text, color, life, maxLife, vy }
  #comboFlash = 0;    // frames remaining for combo flash
  #shieldFlash = 0;
  #rafId      = null;
  #clock      = 0;    // frame counter for animations

  constructor(canvasEl) {
    this.#canvas = canvasEl;
    this.#ctx    = canvasEl.getContext('2d');
    this.#canvas.width  = GRID.COLS * C;
    this.#canvas.height = GRID.ROWS * C;
    this.#startLoop();
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /** Called every engine tick via engine.onStateChange() */
  draw(state) {
    this.#state = state;
  }

  /** Called by main.js on EVENTS.FOOD_EATEN */
  notifyFoodEaten({ earned, combo, multiplier }, foodPos) {
    this.#spawnFoodParticles(foodPos);
    const label = combo > 1
      ? `+${earned} ×${combo} COMBO`
      : `+${earned}`;
    const color = combo > 2 ? P.multiplier : (multiplier > 1 ? P.multiplier : P.accent);
    this.#spawnPopup(foodPos, label, color);
    if (combo > 1) this.#comboFlash = 6;
  }

  /** Called by main.js on EVENTS.SHIELD_HIT */
  notifyShieldHit() {
    this.#shieldFlash = 12;
    if (this.#state?.snake[0]) {
      this.#spawnShieldParticles(this.#state.snake[0]);
    }
  }

  /** Called by main.js on EVENTS.POWERUP_GRAB */
  notifyPowerUpGrab({ type }, pos) {
    if (!pos) return;
    const color = this.#powerUpColor(type);
    this.#spawnFoodParticles(pos, color, 20);
    this.#spawnPopup(pos, type, color);
  }

  /** Called by main.js on EVENTS.LEVEL_UP */
  notifyLevelUp({ level }) {
    const cx = GRID.COLS / 2;
    const cy = GRID.ROWS / 2;
    this.#spawnPopup({ x: cx, y: cy - 2 }, `LEVEL ${level}`, P.accent, 2.5);
  }

  // ─── Render Loop ─────────────────────────────────────────────────────────────

  #startLoop() {
    const loop = () => {
      this.#clock++;
      if (this.#state) this.#render();
      this.#rafId = requestAnimationFrame(loop);
    };
    this.#rafId = requestAnimationFrame(loop);
  }

  #render() {
    const { ctx } = this;
    const state   = this.#state;
    const W = this.#canvas.width;
    const H = this.#canvas.height;

    // Clear
    this.#ctx.clearRect(0, 0, W, H);

    // Layers (back to front)
    this.#drawBackground(W, H);
    this.#drawGrid();
    this.#drawFood(state.food);
    if (state.boardPowerUp) this.#drawBoardPowerUp(state.boardPowerUp);
    this.#drawSnake(state.snake, state.direction, state.activeEffects ?? []);
    this.#drawParticles();
    this.#drawPopups();
    if (this.#comboFlash > 0) { this.#drawComboFlash(W, H); this.#comboFlash--; }
    if (this.#shieldFlash > 0) { this.#drawShieldFlash(W, H); this.#shieldFlash--; }

    // Status overlays
    if (state.status === GAME_STATUS.IDLE)
      this.#drawOverlay('SNAKE', 'Press Space or Start to play', state);
    else if (state.status === GAME_STATUS.PAUSED)
      this.#drawOverlay('PAUSED', 'Press Space to resume', state);
    else if (state.status === GAME_STATUS.GAME_OVER)
      this.#drawGameOverOverlay(state);
  }

  get ctx() { return this.#ctx; }

  // ─── Background ──────────────────────────────────────────────────────────────

  #drawBackground(W, H) {
    const ctx = this.#ctx;
    // Subtle vignette
    const vignette = ctx.createRadialGradient(W/2, H/2, W*0.25, W/2, H/2, W*0.8);
    vignette.addColorStop(0, '#0d0d16');
    vignette.addColorStop(1, P.bg);
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, W, H);
  }

  // ─── Grid ─────────────────────────────────────────────────────────────────────

  #drawGrid() {
    const ctx = this.#ctx;
    ctx.strokeStyle = P.gridLine;
    ctx.lineWidth   = 0.5;
    for (let x = 0; x <= GRID.COLS; x++) {
      ctx.beginPath(); ctx.moveTo(x*C, 0); ctx.lineTo(x*C, GRID.ROWS*C); ctx.stroke();
    }
    for (let y = 0; y <= GRID.ROWS; y++) {
      ctx.beginPath(); ctx.moveTo(0, y*C); ctx.lineTo(GRID.COLS*C, y*C); ctx.stroke();
    }
  }

  // ─── Food ─────────────────────────────────────────────────────────────────────

  #drawFood({ x, y }) {
    const ctx  = this.#ctx;
    const cx   = x*C + C/2;
    const cy   = y*C + C/2;
    const pulse = 1 + 0.18 * Math.sin(this.#clock * 0.12);
    const r    = (C/2 - 4) * pulse;

    // Outer glow
    const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 2.2);
    grd.addColorStop(0, P.foodGlow);
    grd.addColorStop(1, 'transparent');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(cx, cy, r * 2.2, 0, Math.PI*2); ctx.fill();

    // Core circle
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI*2);
    ctx.fillStyle = P.food;
    ctx.fill();

    // Specular
    ctx.beginPath();
    ctx.arc(cx - r*0.28, cy - r*0.28, r*0.32, 0, Math.PI*2);
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fill();
  }

  // ─── Board Power-Up ───────────────────────────────────────────────────────────

  #drawBoardPowerUp({ type, x, y, ticksLeft }) {
    const ctx   = this.#ctx;
    const cx    = x*C + C/2;
    const cy    = y*C + C/2;
    const color = this.#powerUpColor(type);
    const angle = this.#clock * 0.06;
    const warn  = ticksLeft < 10; // flash when about to despawn
    const alpha = warn ? (0.4 + 0.6 * Math.abs(Math.sin(this.#clock * 0.25))) : 1;

    ctx.globalAlpha = alpha;

    // Rotating ring
    ctx.beginPath();
    ctx.arc(cx, cy, C/2 - 2, 0, Math.PI*2);
    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -angle * 20;
    ctx.stroke();
    ctx.setLineDash([]);

    // Glow fill
    const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, C/2);
    grd.addColorStop(0, color.replace(')', ',0.25)').replace('rgb', 'rgba'));
    grd.addColorStop(1, 'transparent');
    ctx.fillStyle = grd;
    ctx.beginPath(); ctx.arc(cx, cy, C/2 - 2, 0, Math.PI*2); ctx.fill();

    // Icon text
    ctx.fillStyle = color;
    ctx.font      = `bold ${Math.round(C * 0.45)}px monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.#powerUpIcon(type), cx, cy);
    ctx.textBaseline = 'alphabetic';
    ctx.textAlign = 'left';

    ctx.globalAlpha = 1;
  }

  // ─── Snake ───────────────────────────────────────────────────────────────────

  #drawSnake(snake, direction, activeEffects) {
    const hasShield = activeEffects.includes(POWERUP_TYPE.SHIELD);
    const hasMult   = activeEffects.includes(POWERUP_TYPE.MULTIPLIER);
    const hasSlow   = activeEffects.includes(POWERUP_TYPE.SLOW);

    // Determine tint from active effect
    let effectColor = null;
    if (hasShield)    effectColor = P.shield;
    else if (hasMult) effectColor = P.multiplier;
    else if (hasSlow) effectColor = P.slow;

    // Draw from tail to head so head always on top
    for (let i = snake.length - 1; i >= 0; i--) {
      const seg    = snake[i];
      const isHead = i === 0;
      const t      = i / Math.max(snake.length - 1, 1); // 0=head,1=tail

      // Color interpolation head→tail
      let fill;
      if (effectColor) {
        // Blend snake color with effect color
        fill = isHead ? effectColor : this.#blendHex(P.snakeBody, effectColor, 0.4 * (1-t));
      } else {
        const alpha = Math.max(0.25, 1 - t * 0.72);
        fill = isHead ? P.snakeHead : `rgba(0,${Math.round(180 + 24*(1-t))},${Math.round(80*(1-t)+20)},${alpha})`;
      }

      const pad    = isHead ? 1 : 2 + t * 1;
      const radius = isHead ? 7 : 5 - t * 2;
      const px     = seg.x * C + pad;
      const py     = seg.y * C + pad;
      const pw     = C - pad * 2;
      const ph     = C - pad * 2;

      // Shield aura on head
      if (isHead && hasShield) {
        this.#ctx.shadowColor = P.shield;
        this.#ctx.shadowBlur  = 12 + 6 * Math.sin(this.#clock * 0.2);
      }

      this.#roundRect(px, py, pw, ph, Math.max(2, radius));
      this.#ctx.fillStyle   = fill;
      this.#ctx.strokeStyle = effectColor ? effectColor.replace(')', ',0.4)').replace('#', 'rgba(') : P.snakeDark;
      this.#ctx.lineWidth   = 1;
      this.#ctx.fill();
      this.#ctx.stroke();

      this.#ctx.shadowBlur = 0;

      if (isHead) this.#drawEyes(seg, direction, effectColor);
    }

    // Slow effect: faint speed lines behind head
    if (hasSlow && snake.length > 1) {
      this.#drawSlowLines(snake[0], direction);
    }
  }

  #drawEyes(seg, direction, effectColor) {
    const ctx = this.#ctx;
    const cx  = seg.x * C + C/2;
    const cy  = seg.y * C + C/2;

    // Offset eyes based on direction
    const eyeOffsets = {
      RIGHT: [{ ex:  4, ey: -4 }, { ex:  4, ey:  4 }],
      LEFT:  [{ ex: -4, ey: -4 }, { ex: -4, ey:  4 }],
      UP:    [{ ex: -4, ey: -4 }, { ex:  4, ey: -4 }],
      DOWN:  [{ ex: -4, ey:  4 }, { ex:  4, ey:  4 }],
    };
    const offsets = eyeOffsets[direction] ?? eyeOffsets.RIGHT;

    for (const { ex, ey } of offsets) {
      // White sclera
      ctx.beginPath();
      ctx.arc(cx + ex, cy + ey, 3, 0, Math.PI*2);
      ctx.fillStyle = effectColor ?? P.white;
      ctx.fill();
      // Pupil
      ctx.beginPath();
      ctx.arc(cx + ex + 0.8, cy + ey + 0.8, 1.4, 0, Math.PI*2);
      ctx.fillStyle = '#0a0a0f';
      ctx.fill();
    }
  }

  #drawSlowLines(head, direction) {
    const ctx = this.#ctx;
    const cx  = head.x * C + C/2;
    const cy  = head.y * C + C/2;
    const dx  = direction === 'LEFT' ? 1 : direction === 'RIGHT' ? -1 : 0;
    const dy  = direction === 'UP'   ? 1 : direction === 'DOWN'  ? -1 : 0;

    ctx.strokeStyle = P.slow;
    ctx.lineWidth   = 1;
    for (let i = 0; i < 3; i++) {
      const offset = (i - 1) * 5;
      const len    = 8 + i * 4;
      const ox     = dy * offset;
      const oy     = dx * offset;
      ctx.globalAlpha = 0.15 + i * 0.08;
      ctx.beginPath();
      ctx.moveTo(cx + ox, cy + oy);
      ctx.lineTo(cx + ox + dx * len, cy + oy + dy * len);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // ─── Particles ───────────────────────────────────────────────────────────────

  #spawnFoodParticles({ x, y }, color = P.food, count = 12) {
    const cx = x*C + C/2;
    const cy = y*C + C/2;
    for (let i = 0; i < count; i++) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.5;
      const speed = 1.5 + Math.random() * 2.5;
      this.#particles.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1, maxLife: 1,
        color, r: 2 + Math.random() * 2,
      });
    }
  }

  #spawnShieldParticles({ x, y }) {
    const cx = x*C + C/2;
    const cy = y*C + C/2;
    for (let i = 0; i < 16; i++) {
      const angle = (Math.PI * 2 * i) / 16;
      const speed = 2 + Math.random() * 3;
      this.#particles.push({
        x: cx, y: cy,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1, maxLife: 1,
        color: P.shield, r: 2 + Math.random() * 3,
      });
    }
  }

  #drawParticles() {
    const ctx    = this.#ctx;
    const dt     = 1;
    const toKeep = [];

    for (const p of this.#particles) {
      p.x  += p.vx * dt;
      p.y  += p.vy * dt;
      p.vy += 0.08; // gravity
      p.life -= 0.035;

      if (p.life <= 0) continue;
      toKeep.push(p);

      ctx.globalAlpha = p.life / p.maxLife;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI*2);
      ctx.fillStyle = p.color;
      ctx.fill();
    }

    ctx.globalAlpha = 1;
    this.#particles = toKeep;
  }

  // ─── Floating Popups ─────────────────────────────────────────────────────────

  #spawnPopup({ x, y }, text, color, scale = 1) {
    this.#popups.push({
      x: x*C + C/2,
      y: y*C,
      text, color,
      life: 1, maxLife: 1,
      vy: -1.2,
      scale,
    });
  }

  #drawPopups() {
    const ctx    = this.#ctx;
    const toKeep = [];

    for (const p of this.#popups) {
      p.y    += p.vy;
      p.life -= 0.022;
      if (p.life <= 0) continue;
      toKeep.push(p);

      ctx.globalAlpha  = Math.min(1, p.life * 3);
      ctx.fillStyle    = p.color;
      ctx.font         = `bold ${Math.round(13 * p.scale)}px "Courier New", monospace`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.text, p.x, p.y);
    }

    ctx.globalAlpha  = 1;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'alphabetic';
    this.#popups = toKeep;
  }

  // ─── Flash Effects ────────────────────────────────────────────────────────────

  #drawComboFlash(W, H) {
    const alpha = (this.#comboFlash / 6) * 0.12;
    this.#ctx.fillStyle = `rgba(255,215,0,${alpha})`;
    this.#ctx.fillRect(0, 0, W, H);
  }

  #drawShieldFlash(W, H) {
    const alpha = (this.#shieldFlash / 12) * 0.18;
    this.#ctx.fillStyle = `rgba(0,238,255,${alpha})`;
    this.#ctx.fillRect(0, 0, W, H);
  }

  // ─── Overlays ─────────────────────────────────────────────────────────────────

  #drawOverlay(title, subtitle, state) {
    const ctx = this.#ctx;
    const W   = this.#canvas.width;
    const H   = this.#canvas.height;

    ctx.fillStyle = P.overlayBg;
    ctx.fillRect(0, 0, W, H);

    // Title
    ctx.fillStyle    = P.accent;
    ctx.font         = 'bold 38px "Courier New", monospace';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(title, W/2, H/2 - 22);

    // Subtitle
    ctx.fillStyle = P.muted;
    ctx.font      = '14px "Courier New", monospace';
    ctx.fillText(subtitle, W/2, H/2 + 16);

    // High score
    if (state?.highScore > 0) {
      ctx.fillStyle = P.multiplier;
      ctx.font      = '12px "Courier New", monospace';
      ctx.fillText(`Best: ${state.highScore}`, W/2, H/2 + 44);
    }

    ctx.textAlign    = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  #drawGameOverOverlay(state) {
    const ctx = this.#ctx;
    const W   = this.#canvas.width;
    const H   = this.#canvas.height;

    ctx.fillStyle = P.overlayBg;
    ctx.fillRect(0, 0, W, H);

    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';

    // Title
    ctx.fillStyle = P.danger;
    ctx.font      = 'bold 38px "Courier New", monospace';
    ctx.fillText('GAME OVER', W/2, H/2 - 50);

    // Score
    ctx.fillStyle = P.white;
    ctx.font      = 'bold 22px "Courier New", monospace';
    ctx.fillText(`Score: ${state.score}`, W/2, H/2 - 10);

    // High score
    if (state.highScore > 0) {
      const isRecord = state.score >= state.highScore && state.score > 0;
      ctx.fillStyle = P.multiplier;
      ctx.font      = '14px "Courier New", monospace';
      ctx.fillText(
        isRecord ? `★ NEW RECORD: ${state.highScore} ★` : `Best: ${state.highScore}`,
        W/2, H/2 + 22
      );
    }

    // Level reached
    ctx.fillStyle = P.muted;
    ctx.font      = '12px "Courier New", monospace';
    ctx.fillText(`Level ${state.level ?? 1} reached`, W/2, H/2 + 48);

    // Restart hint
    ctx.fillStyle = P.accent;
    ctx.font      = '13px "Courier New", monospace';
    ctx.fillText('Press Space or Start to retry', W/2, H/2 + 76);

    ctx.textAlign    = 'left';
    ctx.textBaseline = 'alphabetic';
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────────

  #roundRect(x, y, w, h, r) {
    const ctx = this.#ctx;
    r = Math.min(r, w/2, h/2);
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y,     x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x,     y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x,     y,     x + r, y);
    ctx.closePath();
  }

  #powerUpColor(type) {
    return { SHIELD: P.shield, MULTIPLIER: P.multiplier, SLOW: P.slow }[type] ?? P.accent;
  }

  #powerUpIcon(type) {
    return { SHIELD: '🛡', MULTIPLIER: '×2', SLOW: '❄' }[type] ?? '?';
  }

  /** Blend two hex colors by ratio t (0=a, 1=b) — used for effect tinting */
  #blendHex(a, b, t) {
    const parse = h => [
      parseInt(h.slice(1,3),16),
      parseInt(h.slice(3,5),16),
      parseInt(h.slice(5,7),16),
    ];
    try {
      const [ar,ag,ab] = parse(a);
      const [br,bg,bb] = parse(b);
      const r = Math.round(ar + (br-ar)*t);
      const g = Math.round(ag + (bg-ag)*t);
      const bl= Math.round(ab + (bb-ab)*t);
      return `rgb(${r},${g},${bl})`;
    } catch {
      return a;
    }
  }
}
