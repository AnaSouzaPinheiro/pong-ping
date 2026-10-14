/*
 * mock-server.js — SERVIDOR SIMULADO, apenas para desenvolver/testar a interface.
 *
 * NÃO é o servidor do projeto e NÃO recebe dados dos ESP32. Ele implementa a
 * proposta de protocolo descrita em web/js/protocol.js com raquetes controladas
 * por uma IA simples, para que a interface possa ser vista em funcionamento
 * enquanto a lógica real do jogo não existe em server/server.js.
 *
 * Uso (na pasta web/):
 *   node dev/mock-server.js            -> http://localhost:8081/?ws=ws://localhost:8081
 *
 * No terminal: [1]/[2] alterna a conexão simulada de cada jogador, [q] encerra.
 * Reutiliza a biblioteca "ws" já instalada em ../server/node_modules.
 */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const WebSocket = require(require.resolve("ws", { paths: [path.join(__dirname, "../../server")] }));

const PORT = Number(process.env.PORT) || 8081;
const WEB_ROOT = path.join(__dirname, "..");
const W = 800;
const H = 500;
const PADDLE_H = 90;
const PADDLE_X = W * 0.035;
const BALL_R = 8;
const TARGET = 5;
const TICK_MS = 1000 / 60;      // física a 60 Hz
const BROADCAST_EVERY = 2;      // envia estado a 30 Hz (testa a interpolação)

// ---- Arquivos estáticos ----------------------------------------------------

const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml" };

const httpServer = http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.normalize(path.join(WEB_ROOT, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(WEB_ROOT)) return res.writeHead(403).end();
  fs.readFile(file, (err, data) => {
    if (err) return res.writeHead(404).end("not found");
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

// ---- Estado simulado -------------------------------------------------------

const game = {
  status: "waiting",
  ball: { x: W / 2, y: H / 2, vx: 0, vy: 0 },
  paddles: { p1: H / 2, p2: H / 2 },
  score: { p1: 0, p2: 0 },
  players: { p1: "disconnected", p2: "disconnected" },
  winner: null,
  goalUntil: 0,
};

function serveBall(direction) {
  const angle = (Math.random() - 0.5) * 0.9;
  const speed = 6;
  game.ball = { x: W / 2, y: H / 2, vx: Math.cos(angle) * speed * direction, vy: Math.sin(angle) * speed };
}

function resetMatch() {
  game.score = { p1: 0, p2: 0 };
  game.winner = null;
  game.ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
  game.paddles = { p1: H / 2, p2: H / 2 };
  game.status = bothConnected() ? "ready" : "waiting";
}

const bothConnected = () => game.players.p1 === "connected" && game.players.p2 === "connected";

function step(now) {
  if (game.status === "waiting" && bothConnected()) game.status = "ready";
  if ((game.status === "ready" || game.status === "playing") && !bothConnected()) game.status = game.status === "playing" ? "paused" : "waiting";
  if (game.status === "goal" && now > game.goalUntil) {
    game.status = "playing";
    serveBall(Math.random() < 0.5 ? -1 : 1);
  }
  if (game.status !== "playing") return;

  const b = game.ball;
  // IA "imitando" quem segura o ESP32: segue a bola com atraso e erro.
  for (const key of ["p1", "p2"]) {
    if (game.players[key] !== "connected") continue;
    const coming = key === "p1" ? b.vx < 0 : b.vx > 0;
    const target = coming ? b.y + Math.sin(now / 400 + (key === "p1" ? 0 : 2)) * 30 : H / 2;
    game.paddles[key] += Math.max(-5.5, Math.min(5.5, (target - game.paddles[key]) * 0.12));
  }

  b.x += b.vx;
  b.y += b.vy;
  if (b.y < BALL_R || b.y > H - BALL_R) {
    b.vy *= -1;
    b.y = Math.max(BALL_R, Math.min(H - BALL_R, b.y));
  }

  for (const [key, x, dir] of [["p1", PADDLE_X, 1], ["p2", W - PADDLE_X, -1]]) {
    const hitsX = dir === 1 ? b.x - BALL_R <= x + 5 && b.vx < 0 : b.x + BALL_R >= x - 5 && b.vx > 0;
    const hitsY = Math.abs(b.y - game.paddles[key]) <= PADDLE_H / 2 + BALL_R;
    if (hitsX && hitsY) {
      const offset = (b.y - game.paddles[key]) / (PADDLE_H / 2);
      const speed = Math.min(13, Math.hypot(b.vx, b.vy) * 1.05);
      b.vx = Math.cos(offset * 0.8) * speed * dir;
      b.vy = Math.sin(offset * 0.8) * speed;
    }
  }

  const scorer = b.x < -BALL_R * 2 ? "p2" : b.x > W + BALL_R * 2 ? "p1" : null;
  if (scorer) {
    game.score[scorer] += 1;
    if (game.score[scorer] >= TARGET) {
      game.status = "finished";
      game.winner = scorer === "p1" ? 1 : 2;
    } else {
      game.status = "goal";
      game.goalUntil = now + 1400;
    }
    game.ball = { x: W / 2, y: H / 2, vx: 0, vy: 0 };
  }
}

let seq = 0;
function snapshot() {
  return JSON.stringify({
    type: "state",
    seq: ++seq,
    status: game.status,
    arena: { width: W, height: H },
    ball: { x: game.ball.x, y: game.ball.y, r: BALL_R },
    paddles: { p1: { y: game.paddles.p1, h: PADDLE_H }, p2: { y: game.paddles.p2, h: PADDLE_H } },
    score: game.score,
    players: game.players,
    targetScore: TARGET,
    winner: game.winner,
  });
}

// ---- WebSocket -------------------------------------------------------------

const wss = new WebSocket.Server({ server: httpServer });

function broadcast() {
  const data = snapshot();
  for (const client of wss.clients) if (client.readyState === WebSocket.OPEN) client.send(data);
}

wss.on("connection", (ws) => {
  console.log("[mock] navegador conectado");
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    console.log("[mock] recebido:", msg);

    if (msg.type === "request_state") ws.send(snapshot());
    if (msg.type !== "command") return;

    if (msg.action === "start" && game.status === "ready") {
      game.status = "playing";
      serveBall(Math.random() < 0.5 ? -1 : 1);
    } else if (msg.action === "pause" && (game.status === "playing" || game.status === "goal")) {
      game.status = "paused";
    } else if (msg.action === "resume" && game.status === "paused" && bothConnected()) {
      game.status = "playing";
      if (!game.ball.vx) serveBall(1);
    } else if (msg.action === "reset") {
      resetMatch();
    } else {
      ws.send(JSON.stringify({ type: "error", message: `Comando "${msg.action}" ignorado no estado "${game.status}"` }));
    }
    broadcast();
  });
});

let tick = 0;
setInterval(() => {
  step(Date.now());
  if (++tick % BROADCAST_EVERY === 0) broadcast();
}, TICK_MS);

// Os "ESP32" simulados se conectam alguns segundos depois de iniciar.
setTimeout(() => { game.players.p1 = "connected"; }, 2500);
setTimeout(() => { game.players.p2 = "connected"; }, 4500);

function toggle(key) {
  game.players[key] = game.players[key] === "connected" ? "disconnected" : "connected";
  console.log(`[mock] ${key}: ${game.players[key]}`);
}

if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
  process.stdin.on("data", (buf) => {
    const k = buf.toString();
    if (k === "1") toggle("p1");
    if (k === "2") toggle("p2");
    if (k === "q" || k === "\u0003") process.exit(0);
  });
}

httpServer.listen(PORT, () => {
  console.log(`[mock] SERVIDOR SIMULADO — não usa os ESP32`);
  console.log(`[mock] abra http://localhost:${PORT}/?ws=ws://localhost:${PORT}`);
  console.log(`[mock] teclas: [1]/[2] conecta/desconecta jogador, [q] sai`);
});
