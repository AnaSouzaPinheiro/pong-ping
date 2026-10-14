/*
 * renderer.js — Desenho da arena em <canvas>
 *
 * Recebe, a cada quadro, uma "visão" pronta (posições entre 0 e 1) e apenas
 * desenha. Não calcula física, colisões nem pontuação: isso é do servidor.
 * Os efeitos visuais (rastro da bola, brilho do gol) são puramente estéticos.
 */
(function () {
  "use strict";

  const PADDLE_INSET = 0.035;   // distância da raquete até a parede (fração da largura)
  const PADDLE_WIDTH = 0.012;   // largura da raquete (fração da largura)
  const DEFAULT_PADDLE_H = 0.2; // altura padrão (fração da altura)
  const DEFAULT_BALL_R = 0.016; // raio padrão (fração da altura)
  const TRAIL_LENGTH = 9;

  class ArenaRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext("2d");
      this.staticLayer = document.createElement("canvas");
      this.trail = [];
      this.width = 0;
      this.height = 0;
      this.dpr = 1;
      this.readPalette();
    }

    /** As cores ficam no CSS (:root) para manter uma única fonte de verdade. */
    readPalette() {
      const css = getComputedStyle(document.documentElement);
      const get = (name) => css.getPropertyValue(name).trim();
      this.colors = {
        p1: get("--p1"),
        p2: get("--p2"),
        ball: get("--ball"),
        line: get("--arena-line"),
        grid: get("--arena-grid"),
        bgInner: get("--arena-bg-inner"),
        bgOuter: get("--arena-bg-outer"),
      };
    }

    resize(cssWidth, cssHeight, dpr) {
      this.dpr = dpr;
      this.width = Math.round(cssWidth * dpr);
      this.height = Math.round(cssHeight * dpr);
      this.canvas.width = this.staticLayer.width = this.width;
      this.canvas.height = this.staticLayer.height = this.height;
      this.drawStaticLayer();
    }

    /** Fundo, grade, linha central e bordas: desenhados uma vez por redimensionamento. */
    drawStaticLayer() {
      const ctx = this.staticLayer.getContext("2d");
      const { width: W, height: H, dpr, colors } = this;
      if (!W || !H) return;

      const bg = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.hypot(W, H) / 2);
      bg.addColorStop(0, colors.bgInner);
      bg.addColorStop(1, colors.bgOuter);
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, W, H);

      // Leve tom de cada time no seu lado da arena.
      const side = (x0, x1, color) => {
        const g = ctx.createLinearGradient(x0, 0, x1, 0);
        g.addColorStop(0, withAlpha(color, 0.07));
        g.addColorStop(1, withAlpha(color, 0));
        ctx.fillStyle = g;
        ctx.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), H);
      };
      side(0, W * 0.3, colors.p1);
      side(W, W * 0.7, colors.p2);

      // Grade discreta.
      const cell = H / 10;
      ctx.strokeStyle = colors.grid;
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      for (let x = W / 2 % cell; x < W; x += cell) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, H);
      }
      for (let y = cell; y < H; y += cell) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(W, Math.round(y) + 0.5);
      }
      ctx.stroke();

      // Linha central tracejada e círculo central.
      ctx.strokeStyle = colors.line;
      ctx.lineWidth = 2 * dpr;
      ctx.setLineDash([H / 36, H / 36]);
      ctx.beginPath();
      ctx.moveTo(W / 2, H / 72);
      ctx.lineTo(W / 2, H);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.globalAlpha = 0.6;
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, H * 0.13, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Marcações de canto, ao estilo de mira de fliperama.
      const m = 14 * dpr;
      const len = Math.min(W, H) * 0.05;
      ctx.lineWidth = 2 * dpr;
      ctx.lineCap = "round";
      const corner = (x, y, dx, dy, color) => {
        ctx.strokeStyle = withAlpha(color, 0.55);
        ctx.beginPath();
        ctx.moveTo(x + dx * len, y);
        ctx.lineTo(x, y);
        ctx.lineTo(x, y + dy * len);
        ctx.stroke();
      };
      corner(m, m, 1, 1, colors.p1);
      corner(m, H - m, 1, -1, colors.p1);
      corner(W - m, m, -1, 1, colors.p2);
      corner(W - m, H - m, -1, -1, colors.p2);
    }

    /**
     * view = {
     *   ball: {x, y, r} | null,
     *   paddles: { p1: {y, h} | null, p2: {y, h} | null },
     *   players: { p1, p2 },         "connected" | "disconnected" | "reconnecting" | "unknown"
     *   showTrail: boolean,
     *   goalFx: { side: "left"|"right", color: "p1"|"p2", progress: 0..1 } | null,
     *   hitFx:  { p1: 0..1, p2: 0..1 }  (1 = acabou de rebater)
     * }
     */
    draw(view) {
      const { ctx, width: W, height: H } = this;
      if (!W || !H) return;

      ctx.clearRect(0, 0, W, H);
      ctx.drawImage(this.staticLayer, 0, 0);

      if (view.goalFx) this.drawGoalFlash(view.goalFx);

      this.drawPaddle("p1", view.paddles.p1, view.players.p1, view.hitFx.p1);
      this.drawPaddle("p2", view.paddles.p2, view.players.p2, view.hitFx.p2);

      if (view.ball) {
        this.updateTrail(view.ball, view.showTrail);
        this.drawBall(view.ball);
      } else {
        this.trail.length = 0;
      }
    }

    drawPaddle(key, paddle, playerState, hit) {
      const { ctx, width: W, height: H, dpr } = this;
      const color = this.colors[key];
      const w = Math.max(6 * dpr, W * PADDLE_WIDTH);
      const h = (paddle && paddle.h ? paddle.h : DEFAULT_PADDLE_H) * H;
      const cx = key === "p1" ? W * PADDLE_INSET : W * (1 - PADDLE_INSET);
      const cy = (paddle ? paddle.y : 0.5) * H;
      const x = cx - w / 2;
      const y = clamp(cy - h / 2, 0, H - h);

      // Sem posição do servidor: apenas o contorno da "vaga" da raquete.
      if (!paddle) {
        ctx.save();
        ctx.strokeStyle = withAlpha(color, 0.28);
        ctx.lineWidth = 1.5 * dpr;
        ctx.setLineDash([4 * dpr, 5 * dpr]);
        roundRect(ctx, x, y, w, h, w / 2);
        ctx.stroke();
        ctx.restore();
        return;
      }

      const live = playerState === "connected";
      ctx.save();
      ctx.globalAlpha = live ? 1 : 0.35;
      ctx.shadowColor = color;
      ctx.shadowBlur = (live ? 16 + 18 * hit : 0) * dpr;
      ctx.fillStyle = color;
      roundRect(ctx, x, y, w, h, w / 2);
      ctx.fill();

      // Núcleo claro: dá volume sem exagerar no neon.
      ctx.shadowBlur = 0;
      ctx.fillStyle = withAlpha("#ffffff", 0.35 + 0.4 * hit);
      roundRect(ctx, cx - w * 0.15, y + w * 0.6, w * 0.3, h - w * 1.2, w * 0.15);
      ctx.fill();
      ctx.restore();
    }

    updateTrail(ball, enabled) {
      const last = this.trail[this.trail.length - 1];
      // Saltos grandes (bola reposicionada após gol) não devem gerar rastro.
      if (!enabled || (last && Math.hypot(ball.x - last.x, ball.y - last.y) > 0.2)) {
        this.trail.length = 0;
      }
      if (enabled) {
        this.trail.push({ x: ball.x, y: ball.y });
        if (this.trail.length > TRAIL_LENGTH) this.trail.shift();
      }
    }

    drawBall(ball) {
      const { ctx, width: W, height: H, dpr, colors } = this;
      const r = (ball.r || DEFAULT_BALL_R) * H;

      for (let i = 0; i < this.trail.length - 1; i++) {
        const t = (i + 1) / this.trail.length;
        ctx.fillStyle = withAlpha(colors.ball, 0.18 * t);
        ctx.beginPath();
        ctx.arc(this.trail[i].x * W, this.trail[i].y * H, r * (0.45 + 0.5 * t), 0, Math.PI * 2);
        ctx.fill();
      }

      ctx.save();
      ctx.shadowColor = colors.ball;
      ctx.shadowBlur = 18 * dpr;
      ctx.fillStyle = colors.ball;
      ctx.beginPath();
      ctx.arc(ball.x * W, ball.y * H, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    drawGoalFlash({ side, color, progress }) {
      const { ctx, width: W, height: H } = this;
      const alpha = 0.32 * (1 - progress);
      const reach = W * (0.18 + 0.2 * progress);
      const x0 = side === "left" ? 0 : W;
      const x1 = side === "left" ? reach : W - reach;
      const g = ctx.createLinearGradient(x0, 0, x1, 0);
      g.addColorStop(0, withAlpha(this.colors[color], alpha));
      g.addColorStop(1, withAlpha(this.colors[color], 0));
      ctx.fillStyle = g;
      ctx.fillRect(Math.min(x0, x1), 0, reach, H);
    }
  }

  // ---- utilitários ------------------------------------------------------

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.roundRect(x, y, w, Math.max(h, 0), r);
  }

  function clamp(v, min, max) {
    return Math.min(max, Math.max(min, v));
  }

  /** Aceita "#rrggbb" e devolve rgba() com a opacidade pedida. */
  function withAlpha(hex, alpha) {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
  }

  window.ArenaRenderer = ArenaRenderer;
})();
