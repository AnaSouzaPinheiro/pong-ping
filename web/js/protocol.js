/*
 * protocol.js — Camada de protocolo (formato das mensagens)
 *
 * ÚNICO lugar do front-end que conhece o formato JSON trocado com o servidor.
 * Quando o protocolo definitivo for implementado no servidor Node.js, apenas
 * este arquivo precisa ser ajustado: o restante da interface trabalha com o
 * "estado normalizado" produzido por normalizeState().
 *
 * ---------------------------------------------------------------------------
 * PROPOSTA DE PROTOCOLO (ainda NÃO implementada no servidor)
 * ---------------------------------------------------------------------------
 * Navegador -> servidor
 *   { "type": "hello", "role": "viewer" }            identifica o navegador
 *   { "type": "request_state" }                      pede o estado atual
 *   { "type": "command", "action": "start" }         start | pause | resume | reset
 *
 * Servidor -> navegador
 *   {
 *     "type": "state",
 *     "seq": 1024,                                   opcional, contador crescente
 *     "status": "playing",                           waiting | ready | playing | paused | goal | finished
 *     "arena":   { "width": 800, "height": 500 },    opcional (ver coordenadas)
 *     "ball":    { "x": 400, "y": 250, "r": 8 },
 *     "paddles": { "p1": { "y": 250, "h": 90 }, "p2": { "y": 250, "h": 90 } },
 *     "score":   { "p1": 2, "p2": 1 },
 *     "players": { "p1": "connected", "p2": "reconnecting" },
 *     "targetScore": 5,                              opcional
 *     "winner": null,                                1 | 2 | null
 *     "countdown": null                              opcional, segundos até iniciar
 *   }
 *   { "type": "event", "name": "goal", "player": 1 } opcional
 *   { "type": "error", "message": "..." }            opcional
 *
 * Coordenadas: se "arena" for enviada, x/y/r/h estão nas unidades da arena do
 * servidor; caso contrário, são frações de 0 a 1. A bola e as raquetes usam o
 * CENTRO como referência. Campos ausentes mantêm o último valor conhecido, o que
 * permite ao servidor enviar atualizações parciais (ex.: só "players").
 */
(function () {
  "use strict";

  const STATUSES = ["waiting", "ready", "playing", "paused", "goal", "finished"];
  const PLAYER_STATES = ["connected", "disconnected", "reconnecting"];

  // ---- Mensagens enviadas pelo navegador --------------------------------

  const outgoing = {
    hello: () => ({ type: "hello", role: "viewer" }),
    requestState: () => ({ type: "request_state" }),
    command: (action) => ({ type: "command", action }),
  };

  // ---- Mensagens recebidas do servidor ----------------------------------

  /** Converte o texto bruto recebido em { kind, ... } ou null se não reconhecido. */
  function parseServerMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!msg || typeof msg !== "object") return null;

    switch (msg.type) {
      case "state":
        return { kind: "state", state: normalizeState(msg) };
      case "event":
        return { kind: "event", name: String(msg.name || ""), player: toPlayerNumber(msg.player) };
      case "error":
        return { kind: "error", message: String(msg.message || "Erro informado pelo servidor") };
      default:
        return null;
    }
  }

  /**
   * Estado normalizado (todas as posições entre 0 e 1). Só inclui os campos
   * presentes na mensagem; quem consome faz o merge com o estado anterior.
   */
  function normalizeState(msg) {
    const out = {};
    const w = num(msg.arena && msg.arena.width);
    const h = num(msg.arena && msg.arena.height);
    const sx = w ? 1 / w : 1;
    const sy = h ? 1 / h : 1;

    if (w && h) out.aspect = w / h;
    if (num(msg.seq) !== null) out.seq = num(msg.seq);
    if (STATUSES.includes(msg.status)) out.status = msg.status;

    if (msg.ball && num(msg.ball.x) !== null && num(msg.ball.y) !== null) {
      out.ball = { x: msg.ball.x * sx, y: msg.ball.y * sy };
      if (num(msg.ball.r) !== null) out.ball.r = msg.ball.r * sy;
    }

    if (msg.paddles) {
      out.paddles = {};
      for (const key of ["p1", "p2"]) {
        const p = msg.paddles[key];
        if (p && num(p.y) !== null) {
          out.paddles[key] = { y: p.y * sy };
          if (num(p.h) !== null) out.paddles[key].h = p.h * sy;
        }
      }
    }

    if (msg.score) {
      out.score = {};
      for (const key of ["p1", "p2"]) {
        if (num(msg.score[key]) !== null) out.score[key] = msg.score[key];
      }
    }

    if (msg.players) {
      out.players = {};
      for (const key of ["p1", "p2"]) {
        const value = normalizePlayerState(msg.players[key]);
        if (value) out.players[key] = value;
      }
    }

    if ("winner" in msg) out.winner = toPlayerNumber(msg.winner);
    if ("countdown" in msg) out.countdown = num(msg.countdown);
    if (num(msg.targetScore) !== null) out.targetScore = msg.targetScore;

    return out;
  }

  /** Aceita "connected" | "disconnected" | "reconnecting", booleano ou { status }. */
  function normalizePlayerState(value) {
    if (typeof value === "boolean") return value ? "connected" : "disconnected";
    if (value && typeof value === "object") value = value.status ?? value.connected;
    if (typeof value === "boolean") return value ? "connected" : "disconnected";
    return PLAYER_STATES.includes(value) ? value : null;
  }

  function toPlayerNumber(value) {
    if (value === 1 || value === "p1" || value === "1") return 1;
    if (value === 2 || value === "p2" || value === "2") return 2;
    return null;
  }

  function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  window.PongProtocol = { outgoing, parseServerMessage };
})();
