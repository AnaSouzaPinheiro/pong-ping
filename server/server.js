/*
 * server.js — Servidor oficial do Pong distribuído
 *
 * Uma única porta (padrão 8080) atende:
 *   - HTTP: entrega o front-end (pasta ../web)
 *   - WebSocket dos ESP32: {"player":1,"x":-34,"y":8,"z":1020}   (formato inalterado)
 *   - WebSocket dos navegadores: {"type":"hello","role":"viewer"}, comandos, etc.
 *
 * O servidor é a AUTORIDADE da partida: move a bola, testa colisões, conta pontos
 * e transmite o estado aos navegadores, que só desenham.
 *
 * Configuração por variáveis de ambiente (todas opcionais):
 *   PORT=8080          porta HTTP + WebSocket
 *   AXIS=y             eixo do acelerômetro que move a raquete (x | y | z)
 *   SENSITIVITY=600    desvio do repouso que leva a raquete até a borda (~1024 = 1g; 600 ≈ 35°)
 *   INVERT_P1=0        1 inverte o sentido da raquete do jogador 1
 *   INVERT_P2=0        1 inverte o sentido da raquete do jogador 2
 *   TARGET_SCORE=5     pontos para vencer
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require("ws");

// ============================================================
// CONFIGURAÇÃO
// ============================================================

const PORT = Number(process.env.PORT) || 8080;
const AXIS = ["x", "y", "z"].includes(process.env.AXIS) ? process.env.AXIS : "y";
const SENSITIVITY = Number(process.env.SENSITIVITY) || 600;
const INVERT = { 1: process.env.INVERT_P1 === "1", 2: process.env.INVERT_P2 === "1" };
const TARGET_SCORE = Number(process.env.TARGET_SCORE) || 5;

const WEB_ROOT = path.join(__dirname, "..", "web");

// Arena em unidades lógicas (o navegador converte para pixels).
const W = 800;
const H = 500;
const PADDLE_H = 100;
const PADDLE_W = 10;
const PADDLE_X = { 1: W * 0.035, 2: W * (1 - 0.035) }; // centro de cada raquete (igual ao renderer.js)
const BALL_R = 8;
const BALL_SPEED_START = 380;  // unidades por segundo
const BALL_SPEED_MAX = 900;
const BALL_SPEEDUP = 1.06;     // a cada rebatida
const MAX_BOUNCE_ANGLE = Math.PI / 3;

const TICK_MS = 1000 / 60;     // física a 60 Hz
const BROADCAST_EVERY = 2;     // estado enviado a 30 Hz
const COUNTDOWN_MS = 3000;
const GOAL_PAUSE_MS = 1500;
const PADDLE_RESPONSE = 12;    // quão rápido a raquete alcança o sensor (1/s); suaviza tremor e envios espaçados

// Sem mensagens do ESP32 por PLAYER_TIMEOUT_MS -> "reconnecting";
// por PLAYER_LOST_MS -> "disconnected".
const PLAYER_TIMEOUT_MS = 1000;
const PLAYER_LOST_MS = 5000;

// ============================================================
// ESTADO DA PARTIDA
// ============================================================

const players = {
  1: { ws: null, lastSeen: 0, target: H / 2, raw: null, lastSeq: null, received: 0, lost: 0 },
  2: { ws: null, lastSeen: 0, target: H / 2, raw: null, lastSeq: null, received: 0, lost: 0 },
};

const game = {
  status: "waiting",           // waiting | ready | playing | paused | goal | finished
  ball: { x: W / 2, y: H / 2, vx: 0, vy: 0 },
  paddles: { 1: H / 2, 2: H / 2 },
  score: { 1: 0, 2: 0 },
  winner: null,
  countdownUntil: 0,           // durante a contagem a bola fica parada
  goalUntil: 0,
  nextServe: 1,                // direção do próximo saque: 1 = para a direita
  autoPaused: false,           // pausa causada por queda de ESP32 (retoma sozinha)
};

const viewers = new Set();

function playerStatus(n, now = Date.now()) {
  const p = players[n];
  if (!p.lastSeen) return "disconnected";
  const silence = now - p.lastSeen;
  if (p.ws && silence < PLAYER_TIMEOUT_MS) return "connected";
  return silence < PLAYER_LOST_MS ? "reconnecting" : "disconnected";
}

const bothConnected = (now) => playerStatus(1, now) === "connected" && playerStatus(2, now) === "connected";

// ============================================================
// SENSOR -> RAQUETE
// ============================================================

function handleSensor(ws, data) {
  const n = data.player;
  const p = players[n];

  if (p.ws !== ws) {
    console.log(`[ESP32 #${n}] conectado`);
    p.ws = ws;
    ws.playerId = n;
  }
  p.lastSeen = Date.now();
  p.received++;

  // Número de sequência: buracos = mensagens perdidas; seq menor = placa reiniciou.
  if (Number.isInteger(data.seq)) {
    if (p.lastSeq !== null && data.seq > p.lastSeq + 1) p.lost += data.seq - p.lastSeq - 1;
    p.lastSeq = data.seq;
  }
  p.raw = { x: data.x, y: data.y, z: data.z };

  // Inclinação -> posição absoluta desejada da raquete (a suavização fica em step()).
  let tilt = Number(data[AXIS]) / SENSITIVITY;
  if (!Number.isFinite(tilt)) return;
  if (INVERT[n]) tilt = -tilt;
  tilt = clamp(tilt, -1, 1);
  p.target = H / 2 + tilt * (H - PADDLE_H) / 2;
}

// ============================================================
// FÍSICA
// ============================================================

function serve(now) {
  const angle = (Math.random() - 0.5) * (Math.PI / 3);
  game.ball = {
    x: W / 2,
    y: H / 2,
    vx: Math.cos(angle) * BALL_SPEED_START * game.nextServe,
    vy: Math.sin(angle) * BALL_SPEED_START,
  };
  game.countdownUntil = now + COUNTDOWN_MS;
}

function centerBall() {
  game.ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
}

function step(now, dt) {
  // Raquetes seguem o sensor de forma suave (também no lobby, para testar o controle).
  const follow = 1 - Math.exp(-PADDLE_RESPONSE * dt);
  for (const n of [1, 2]) {
    const target = clamp(players[n].target, PADDLE_H / 2, H - PADDLE_H / 2);
    game.paddles[n] += (target - game.paddles[n]) * follow;
  }

  // Transições automáticas de estado.
  const ok = bothConnected(now);
  if (game.status === "waiting" && ok) game.status = "ready";
  if (game.status === "ready" && !ok) game.status = "waiting";
  if ((game.status === "playing" || game.status === "goal") && !ok) {
    game.status = "paused";
    game.autoPaused = true;
    console.log("[jogo] pausado: jogador desconectado");
  }
  if (game.status === "paused" && game.autoPaused && ok) {
    resumeGame(now);
    console.log("[jogo] retomado automaticamente: jogadores reconectados");
  }
  if (game.status === "goal" && now >= game.goalUntil) {
    game.status = "playing";
    serve(now);
  }

  if (game.status !== "playing" || now < game.countdownUntil) return;

  const b = game.ball;
  const prevX = b.x;
  b.x += b.vx * dt;
  b.y += b.vy * dt;

  // Paredes de cima e de baixo.
  if (b.y < BALL_R) { b.y = BALL_R; b.vy = Math.abs(b.vy); }
  if (b.y > H - BALL_R) { b.y = H - BALL_R; b.vy = -Math.abs(b.vy); }

  // Raquetes: testa se a bola CRUZOU a face neste passo (evita atravessar em alta velocidade).
  for (const n of [1, 2]) {
    const dir = n === 1 ? 1 : -1;                         // para onde a bola volta
    const face = PADDLE_X[n] + dir * PADDLE_W / 2;
    const movingToward = n === 1 ? b.vx < 0 : b.vx > 0;
    const before = (prevX - dir * BALL_R - face) * dir;   // >= 0: ainda na frente
    const after = (b.x - dir * BALL_R - face) * dir;      // <= 0: cruzou
    const offset = b.y - game.paddles[n];

    if (movingToward && before >= 0 && after <= 0 && Math.abs(offset) <= PADDLE_H / 2 + BALL_R) {
      const rel = clamp(offset / (PADDLE_H / 2), -1, 1);  // onde bateu: -1 topo, 1 base
      const angle = rel * MAX_BOUNCE_ANGLE;
      const speed = Math.min(BALL_SPEED_MAX, Math.hypot(b.vx, b.vy) * BALL_SPEEDUP);
      b.vx = Math.cos(angle) * speed * dir;
      b.vy = Math.sin(angle) * speed;
      b.x = face + dir * BALL_R;
    }
  }

  // Gol.
  const scorer = b.x < -BALL_R ? 2 : b.x > W + BALL_R ? 1 : null;
  if (scorer) {
    game.score[scorer] += 1;
    game.nextServe = scorer === 1 ? 1 : -1;               // saque vai para quem sofreu
    centerBall();
    console.log(`[jogo] gol do jogador ${scorer} — ${game.score[1]} x ${game.score[2]}`);

    if (game.score[scorer] >= TARGET_SCORE) {
      game.status = "finished";
      game.winner = scorer;
      console.log(`[jogo] fim — jogador ${scorer} venceu`);
    } else {
      game.status = "goal";
      game.goalUntil = now + GOAL_PAUSE_MS;
    }
  }
}

function resumeGame(now) {
  game.status = "playing";
  game.autoPaused = false;
  if (game.ball.vx === 0) serve(now);                    // pausou durante o intervalo do gol
  else game.countdownUntil = now + COUNTDOWN_MS;         // contagem antes de voltar
}

// ============================================================
// COMANDOS DO NAVEGADOR
// ============================================================

function handleCommand(ws, action) {
  const now = Date.now();
  const s = game.status;

  if (action === "start" && s === "ready") {
    game.status = "playing";
    game.nextServe = Math.random() < 0.5 ? 1 : -1;
    serve(now);
  } else if (action === "pause" && (s === "playing" || s === "goal")) {
    game.status = "paused";
    game.autoPaused = false;                             // pausa manual só sai com "resume"
  } else if (action === "resume" && s === "paused") {
    if (!bothConnected(now)) return sendError(ws, "Os dois ESP32 precisam estar conectados para retomar.");
    resumeGame(now);
  } else if (action === "reset") {
    game.score = { 1: 0, 2: 0 };
    game.winner = null;
    game.countdownUntil = 0;
    centerBall();
    game.autoPaused = false;
    game.status = bothConnected(now) ? "ready" : "waiting";
  } else {
    return sendError(ws, `Comando "${action}" não é válido no estado "${s}".`);
  }

  console.log(`[jogo] comando ${action}: ${s} -> ${game.status}`);
  broadcast();
}

// ============================================================
// MENSAGENS PARA O NAVEGADOR
// ============================================================

function snapshot() {
  const now = Date.now();
  const countdown = game.status === "playing" && now < game.countdownUntil
    ? Math.ceil((game.countdownUntil - now) / 1000)
    : null;

  return JSON.stringify({
    type: "state",
    status: game.status,
    arena: { width: W, height: H },
    ball: { x: round(game.ball.x), y: round(game.ball.y), r: BALL_R },
    paddles: {
      p1: { y: round(game.paddles[1]), h: PADDLE_H },
      p2: { y: round(game.paddles[2]), h: PADDLE_H },
    },
    score: { p1: game.score[1], p2: game.score[2] },
    players: { p1: playerStatus(1, now), p2: playerStatus(2, now) },
    targetScore: TARGET_SCORE,
    winner: game.winner,
    countdown,
  });
}

function broadcast() {
  if (!viewers.size) return;
  const data = snapshot();
  for (const ws of viewers) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  }
}

function sendError(ws, message) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "error", message }));
}

// ============================================================
// HTTP (entrega o front-end)
// ============================================================

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

const httpServer = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    return res.writeHead(400).end();
  }
  const file = path.normalize(path.join(WEB_ROOT, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(WEB_ROOT + path.sep)) return res.writeHead(403).end();

  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end("Arquivo não encontrado");
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

// ============================================================
// WEBSOCKET
// ============================================================

const wss = new WebSocket.Server({ server: httpServer });

wss.on("connection", (ws, request) => {
  console.log(`Nova conexão recebida! (${request.socket.remoteAddress})`);
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });

  ws.on("message", (message) => {
    let data;
    try {
      data = JSON.parse(message.toString());
    } catch {
      console.log("Mensagem inválida:", message.toString());
      return;
    }

    // ESP32: {"player":1|2,"x":..,"y":..,"z":..}
    if (data.player === 1 || data.player === 2) {
      handleSensor(ws, data);
      return;
    }

    // Navegador
    switch (data.type) {
      case "hello":
        viewers.add(ws);
        console.log(`[navegador] conectado (${viewers.size} assistindo)`);
        break;
      case "request_state":
        viewers.add(ws);
        ws.send(snapshot());
        break;
      case "command":
        handleCommand(ws, data.action);
        break;
      default:
        console.log("Mensagem desconhecida:", data);
    }
  });

  ws.on("close", () => {
    if (viewers.delete(ws)) console.log(`[navegador] saiu (${viewers.size} assistindo)`);
    const n = ws.playerId;
    if (n && players[n].ws === ws) {
      players[n].ws = null;
      console.log(`[ESP32 #${n}] conexão encerrada`);
    }
  });

  ws.on("error", (error) => {
    console.log("Erro WebSocket:", error.message);
  });
});

// Derruba conexões mortas (ex.: placa que perdeu o Wi-Fi sem fechar o socket).
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 10000);

// ============================================================
// LAÇO PRINCIPAL
// ============================================================

let lastTick = Date.now();
let tick = 0;

setInterval(() => {
  const now = Date.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000); // limita saltos se o processo atrasar
  lastTick = now;

  step(now, dt);
  if (++tick % BROADCAST_EVERY === 0) broadcast();
}, TICK_MS);

// A cada 2 s: leituras (para calibrar AXIS/SENSITIVITY), taxa recebida e perdas (Experimentos 2 e 4).
const STATS_MS = 2000;
setInterval(() => {
  for (const n of [1, 2]) {
    const p = players[n];
    if (p.raw && playerStatus(n) === "connected") {
      const rate = (p.received * 1000 / STATS_MS).toFixed(1);
      console.log(`[ESP32 #${n}] x=${p.raw.x} y=${p.raw.y} z=${p.raw.z} -> raquete ${Math.round(game.paddles[n])}` +
        ` | ${rate} msg/s | seq=${p.lastSeq} | perdidas=${p.lost}`);
    }
    p.received = 0;
  }
}, STATS_MS);

// ============================================================
// UTILITÁRIOS
// ============================================================

function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

function round(v) {
  return Math.round(v * 10) / 10;
}

httpServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Jogo:      http://localhost:${PORT}`);
  console.log(`ESP32:     ws://<IP deste computador>:${PORT}`);
  console.log(`Controle:  eixo ${AXIS}, sensibilidade ${SENSITIVITY}, partida até ${TARGET_SCORE}`);
});
