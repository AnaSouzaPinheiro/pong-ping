/*
 * game.js — Interface do jogo
 *
 * Liga as camadas:
 *   PongConnection (transporte)  ->  estado da partida  ->  HTML + ArenaRenderer
 *
 * Regras importantes:
 *   - O navegador NÃO é autoridade: só exibe o último estado enviado pelo servidor.
 *   - Botões apenas enviam pedidos ("command"); nada muda até o servidor responder.
 *   - O estado de cada ESP32 vem do servidor. Sem servidor, ele é "desconhecido".
 *   - A interpolação entre estados recebidos serve só para suavizar a animação.
 */
(function () {
  "use strict";

  const GOAL_BANNER_MS = 1600;     // duração do aviso de gol quando o servidor não envia status "goal"
  const MAX_INTERP_DELAY_MS = 120; // atraso máximo usado para interpolar entre estados
  const UI_TICK_MS = 250;          // frequência de atualização da telemetria e contagens

  // ---- Configuração -----------------------------------------------------

  /**
   * Padrão: o mesmo endereço que serviu a página (server.js serve a página e o
   * WebSocket na mesma porta). Aberta como arquivo local: ws://localhost:8080.
   * Pode ser trocado com ?ws=ws://ip:porta
   */
  function resolveWsUrl() {
    const fromQuery = new URLSearchParams(location.search).get("ws");
    if (fromQuery) return fromQuery;
    if (location.protocol === "http:" || location.protocol === "https:") {
      return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
    }
    return "ws://localhost:8080";
  }

  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

  // ---- Elementos --------------------------------------------------------

  const $ = (id) => document.getElementById(id);
  const els = {
    serverStatus: $("server-status"),
    serverStatusText: $("server-status-text"),
    players: { p1: $("player-1"), p2: $("player-2") },
    scores: { p1: $("score-1"), p2: $("score-2") },
    matchStatus: $("match-status"),
    matchTarget: $("match-target"),
    stage: $("stage"),
    arena: $("arena"),
    canvas: $("arena-canvas"),
    overlay: $("overlay"),
    overlayKicker: $("overlay-kicker"),
    overlayTitle: $("overlay-title"),
    overlayText: $("overlay-text"),
    overlayPlayers: $("overlay-players"),
    overlayAction: $("overlay-action"),
    btnPrimary: $("btn-primary"),
    btnPrimaryLabel: $("btn-primary-label"),
    btnReset: $("btn-reset"),
    btnResetLabel: $("btn-reset-label"),
    btnInfo: $("btn-info"),
    btnFullscreen: $("btn-fullscreen"),
    infoDialog: $("info-dialog"),
    toast: $("toast"),
    tmRate: $("tm-rate"),
    tmAge: $("tm-age"),
    tmUrl: $("tm-url"),
  };

  // ---- Estado local (cópia do que o servidor informou) -------------------

  const server = { status: "connecting", retryAt: null, everConnected: false };

  const match = {
    known: false,               // já recebemos algum estado desde a última conexão?
    status: null,
    score: { p1: null, p2: null },
    players: { p1: "unknown", p2: "unknown" },
    ball: null,
    paddles: { p1: null, p2: null },
    aspect: 16 / 10,
    winner: null,
    countdown: null,
    targetScore: null,
  };

  // Efeitos puramente visuais.
  const fx = {
    goal: null,                 // { scorer, at }
    hitAt: { p1: -Infinity, p2: -Infinity },
    lastBallX: null,
    lastBallDir: 0,
  };

  // Estados recebidos com o horário de chegada, para interpolar.
  const snapshots = [];
  let avgIntervalMs = 33;
  const arrivals = [];          // horários de chegada no último segundo (telemetria)
  let lastStateAt = null;

  // ---- Conexão ----------------------------------------------------------

  const connection = new PongConnection(resolveWsUrl());
  els.tmUrl.textContent = connection.url.replace(/^wss?:\/\//, "");
  els.tmUrl.title = connection.url;

  connection.on("status", ({ status, retryAt }) => {
    server.status = status;
    server.retryAt = retryAt ?? null;

    if (status === "open") {
      server.everConnected = true;
    } else {
      // Sem servidor não sabemos nada sobre os ESP32 nem sobre a bola.
      match.known = false;
      match.players = { p1: "unknown", p2: "unknown" };
      match.ball = null;
      match.paddles = { p1: null, p2: null };
      snapshots.length = 0;
      arrivals.length = 0;
      lastStateAt = null;
    }
    updateUI();
  });

  connection.on("message", (message) => {
    if (message.kind === "state") applyState(message.state);
    else if (message.kind === "event" && message.name === "goal" && message.player) {
      triggerGoal(message.player);
    } else if (message.kind === "error") {
      showToast(message.message, "error");
    }
  });

  function applyState(next) {
    const now = performance.now();
    const previousScore = { ...match.score };
    match.known = true;

    if (next.status) match.status = next.status;
    if (next.score) Object.assign(match.score, next.score);
    if (next.players) Object.assign(match.players, next.players);
    if ("winner" in next) match.winner = next.winner;
    if ("countdown" in next) match.countdown = next.countdown;
    if (next.targetScore) match.targetScore = next.targetScore;
    if (next.aspect && Math.abs(next.aspect - match.aspect) > 0.001) {
      match.aspect = next.aspect;
      layoutArena();
    }

    if (next.ball || next.paddles) {
      if (next.ball) match.ball = { ...match.ball, ...next.ball };
      if (next.paddles) {
        for (const key of ["p1", "p2"]) {
          if (next.paddles[key]) match.paddles[key] = { ...match.paddles[key], ...next.paddles[key] };
        }
      }
      pushSnapshot(now);
    }

    // Placar subiu: animação de gol (apenas visual; quem contou foi o servidor).
    for (const [key, n] of [["p1", 1], ["p2", 2]]) {
      if (previousScore[key] !== null && match.score[key] > previousScore[key]) {
        triggerGoal(n);
        bump(els.scores[key]);
      }
    }

    // Telemetria.
    if (lastStateAt !== null) {
      const delta = Math.min(200, Math.max(5, now - lastStateAt));
      avgIntervalMs += (delta - avgIntervalMs) * 0.1;
    }
    lastStateAt = now;
    arrivals.push(now);

    updateUI();
  }

  function pushSnapshot(t) {
    snapshots.push({
      t,
      ball: match.ball ? { ...match.ball } : null,
      paddles: {
        p1: match.paddles.p1 ? { ...match.paddles.p1 } : null,
        p2: match.paddles.p2 ? { ...match.paddles.p2 } : null,
      },
    });
    while (snapshots.length > 2 && snapshots[1].t < t - 1000) snapshots.shift();
  }

  function triggerGoal(scorer) {
    // Evita disparar duas vezes (evento "goal" + aumento do placar).
    if (fx.goal && fx.goal.scorer === scorer && performance.now() - fx.goal.at < 500) return;
    fx.goal = { scorer, at: performance.now() };
    updateUI();
    setTimeout(updateUI, GOAL_BANNER_MS + 20);
  }

  // ---- Comandos (pedidos ao servidor) -----------------------------------

  const COMMAND_LABELS = { start: "iniciar", pause: "pausar", resume: "retomar", reset: "reiniciar" };

  function sendCommand(action) {
    if (!action) return;
    if (connection.send(PongProtocol.outgoing.command(action))) {
      showToast(`Pedido enviado ao servidor: ${COMMAND_LABELS[action]}`);
    } else {
      showToast("Sem conexão com o servidor", "error");
    }
  }

  /** Qual ação o botão principal representa no estado atual. */
  function primaryAction() {
    if (server.status !== "open" || !match.known) return { label: "Iniciar", action: null };
    switch (match.status) {
      case "ready": return { label: "Iniciar", action: "start" };
      case "playing":
      case "goal": return { label: "Pausar", action: "pause" };
      case "paused": return { label: "Retomar", action: "resume" };
      case "finished": return { label: "Nova partida", action: "reset" };
      default: return { label: "Iniciar", action: null };
    }
  }

  // Reiniciar no meio da partida pede confirmação (segundo clique).
  let resetArmedUntil = 0;
  function requestReset() {
    const midGame = match.status === "playing" || match.status === "paused" || match.status === "goal";
    if (midGame && performance.now() > resetArmedUntil) {
      resetArmedUntil = performance.now() + 2500;
      els.btnResetLabel.textContent = "Confirmar?";
      els.btnReset.classList.add("is-armed");
      setTimeout(() => {
        els.btnResetLabel.textContent = "Reiniciar";
        els.btnReset.classList.remove("is-armed");
      }, 2500);
      return;
    }
    resetArmedUntil = 0;
    els.btnResetLabel.textContent = "Reiniciar";
    els.btnReset.classList.remove("is-armed");
    sendCommand("reset");
  }

  // ---- Interface (HTML) -------------------------------------------------

  const PLAYER_TEXT = {
    connected: "Conectado",
    disconnected: "Desconectado",
    reconnecting: "Reconectando",
    unknown: "Sem dados",
  };

  const STATUS_TEXT = {
    none: "Sem partida",
    waiting: "Aguardando",
    ready: "Pronto",
    playing: "Em jogo",
    paused: "Pausado",
    goal: "Gol!",
    finished: "Fim de jogo",
  };

  function updateUI() {
    // Servidor
    els.serverStatus.dataset.state = server.status;
    els.serverStatusText.textContent = serverStatusText();

    // Jogadores e placar
    for (const key of ["p1", "p2"]) {
      const state = match.players[key];
      els.players[key].dataset.conn = state;
      els.players[key].querySelector(".conn-text").textContent = PLAYER_TEXT[state];
      const score = match.score[key];
      els.scores[key].textContent = score === null ? "–" : String(score);
      els.players[key].classList.toggle("is-winner", match.status === "finished" && match.winner === Number(key[1]));
    }
    document.body.classList.toggle("is-stale", !match.known);

    const status = match.known && match.status ? match.status : "none";
    els.matchStatus.dataset.status = status;
    els.matchStatus.textContent = STATUS_TEXT[status];
    els.matchTarget.textContent = match.targetScore ? `Partida até ${match.targetScore}` : "";

    // Botões
    const primary = primaryAction();
    els.btnPrimaryLabel.textContent = primary.label;
    els.btnPrimary.disabled = !primary.action;
    els.btnPrimary.dataset.action = primary.action || "";
    els.btnReset.disabled = server.status !== "open" || !match.known;

    renderOverlay();
  }

  function serverStatusText() {
    if (server.status === "open") return "Conectado";
    if (server.status === "connecting") return "Conectando…";
    if (server.retryAt) {
      const s = Math.max(0, Math.ceil((server.retryAt - performance.now()) / 1000));
      return s > 0 ? `Offline · tentando em ${s}s` : "Reconectando…";
    }
    return "Reconectando…";
  }

  /** Decide o que aparece sobre a arena. Retorna null quando a arena deve ficar livre. */
  function overlayModel() {
    if (server.status === "connecting") {
      return { kicker: "Servidor", title: "Conectando", text: `Procurando o servidor em ${connection.url}`, busy: true };
    }
    if (server.status === "reconnecting") {
      const s = server.retryAt ? Math.max(0, Math.ceil((server.retryAt - performance.now()) / 1000)) : 0;
      return {
        kicker: server.everConnected ? "Conexão perdida" : "Servidor indisponível",
        title: server.everConnected ? "Reconectando" : "Aguardando servidor",
        text: s > 0 ? `Nova tentativa em ${s} s. Inicie o servidor Node.js na porta indicada.` : "Tentando conectar…",
        action: { label: "Tentar agora", run: () => connection.retryNow() },
        tone: "alert",
        busy: s === 0,
      };
    }
    if (!match.known) {
      return {
        kicker: "Servidor conectado",
        title: "Aguardando partida",
        text: "O servidor ainda não enviou o estado do jogo.",
        busy: true,
      };
    }

    const goalActive = fx.goal && performance.now() - fx.goal.at < GOAL_BANNER_MS;
    const scorer = match.status === "goal" && fx.goal ? fx.goal.scorer : goalActive ? fx.goal.scorer : null;
    const scoreLine = `${match.score.p1 ?? 0}  :  ${match.score.p2 ?? 0}`;

    if (match.countdown !== null && match.countdown > 0 && (match.status === "ready" || match.status === "playing")) {
      return { kicker: "Prepare-se", title: String(match.countdown), big: true };
    }

    switch (match.status) {
      case "waiting":
        return {
          kicker: "Lobby",
          title: "Aguardando jogadores",
          text: "Ligue e conecte os dois ESP32 à rede para começar.",
          players: true,
        };
      case "ready":
        return {
          kicker: "Tudo pronto",
          title: "Pronto para iniciar",
          text: "Os dois controles estão conectados.",
          players: true,
          action: { label: "Iniciar partida", run: () => sendCommand("start") },
        };
      case "paused":
        return {
          kicker: "Partida pausada",
          title: "Pausa",
          text: scoreLine,
          action: { label: "Retomar", run: () => sendCommand("resume") },
        };
      case "finished": {
        const w = match.winner;
        return {
          kicker: "Fim de partida",
          title: w ? `Jogador ${w} vence` : "Empate",
          text: `Placar final  ${scoreLine}`,
          tone: w ? `p${w}` : undefined,
          action: { label: "Nova partida", run: () => sendCommand("reset") },
        };
      }
      case "goal":
      case "playing":
        if (scorer) {
          return { kicker: "Gol", title: `Jogador ${scorer} marca`, text: scoreLine, tone: `p${scorer}`, banner: true };
        }
        if (match.status === "goal") return { kicker: "Gol", title: "Ponto marcado", text: scoreLine, banner: true };
        return null;
      default:
        return null;
    }
  }

  let overlayKey = "";
  function renderOverlay() {
    const model = overlayModel();
    const visible = !!model;
    els.overlay.dataset.visible = String(visible);
    if (!model) {
      overlayKey = "";
      return;
    }

    // Só reconstrói quando o conteúdo muda (evita reiniciar animações CSS).
    const key = JSON.stringify([model.kicker, model.title, model.text, model.tone, model.action && model.action.label, model.players && match.players]);
    if (key === overlayKey) return;
    overlayKey = key;

    els.overlay.dataset.tone = model.tone || "";
    els.overlay.dataset.mode = model.banner ? "banner" : model.big ? "big" : "panel";
    els.overlay.dataset.busy = String(!!model.busy);
    els.overlayKicker.textContent = model.kicker || "";
    els.overlayTitle.textContent = model.title;
    els.overlayText.textContent = model.text || "";
    els.overlayText.hidden = !model.text;

    els.overlayPlayers.hidden = !model.players;
    if (model.players) {
      for (const chip of els.overlayPlayers.children) {
        chip.dataset.conn = match.players[`p${chip.dataset.player}`];
      }
    }

    els.overlayAction.hidden = !model.action;
    if (model.action) {
      els.overlayAction.textContent = model.action.label;
      els.overlayAction.onclick = model.action.run;
    }
  }

  function bump(el) {
    el.classList.remove("bump");
    void el.offsetWidth; // reinicia a animação CSS
    el.classList.add("bump");
  }

  let toastTimer = null;
  function showToast(text, tone = "info") {
    els.toast.textContent = text;
    els.toast.dataset.tone = tone;
    els.toast.classList.add("is-visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("is-visible"), 2400);
  }

  // ---- Arena (canvas) ---------------------------------------------------

  const renderer = new ArenaRenderer(els.canvas);

  /** Encaixa a arena no espaço disponível mantendo a proporção do servidor. */
  function layoutArena() {
    const { clientWidth: sw, clientHeight: sh } = els.stage;
    if (!sw || !sh) return;
    let w = sw;
    let h = w / match.aspect;
    if (h > sh) {
      h = sh;
      w = h * match.aspect;
    }
    w = Math.floor(w);
    h = Math.floor(h);
    els.arena.style.width = `${w}px`;
    els.arena.style.height = `${h}px`;
    renderer.resize(w, h, Math.min(window.devicePixelRatio || 1, 2));
  }

  new ResizeObserver(layoutArena).observe(els.stage);

  /** Interpola entre os dois estados que cercam (agora - atraso). */
  function sampleState(now) {
    if (!snapshots.length) return null;
    const t = now - Math.min(MAX_INTERP_DELAY_MS, avgIntervalMs * 1.2);

    let i = snapshots.length - 1;
    while (i > 0 && snapshots[i].t > t) i--;
    const a = snapshots[i];
    const b = snapshots[i + 1];
    if (!b || t <= a.t) return a;

    const k = (t - a.t) / (b.t - a.t);
    const lerp = (x, y) => x + (y - x) * k;

    let ball = b.ball;
    if (a.ball && b.ball && Math.hypot(b.ball.x - a.ball.x, b.ball.y - a.ball.y) < 0.25) {
      ball = { ...b.ball, x: lerp(a.ball.x, b.ball.x), y: lerp(a.ball.y, b.ball.y) };
    }
    const paddle = (pa, pb) => (pa && pb ? { ...pb, y: lerp(pa.y, pb.y) } : pb);
    return { ball, paddles: { p1: paddle(a.paddles.p1, b.paddles.p1), p2: paddle(a.paddles.p2, b.paddles.p2) } };
  }

  function detectPaddleHit(ball, now) {
    if (!ball) {
      fx.lastBallX = null;
      return;
    }
    if (fx.lastBallX !== null) {
      const dx = ball.x - fx.lastBallX;
      const dir = Math.abs(dx) > 0.0004 ? Math.sign(dx) : fx.lastBallDir;
      if (fx.lastBallDir && dir && dir !== fx.lastBallDir) {
        if (ball.x < 0.2) fx.hitAt.p1 = now;
        else if (ball.x > 0.8) fx.hitAt.p2 = now;
      }
      fx.lastBallDir = dir;
    }
    fx.lastBallX = ball.x;
  }

  function frame(now) {
    const motion = !reducedMotion.matches;
    const sample = sampleState(now);
    const ball = sample ? sample.ball : null;

    detectPaddleHit(ball, now);

    let goalFx = null;
    if (fx.goal && motion) {
      const progress = (now - fx.goal.at) / GOAL_BANNER_MS;
      if (progress < 1) {
        goalFx = { side: fx.goal.scorer === 1 ? "right" : "left", color: `p${fx.goal.scorer}`, progress };
      }
    }
    const hit = (key) => (motion ? Math.max(0, 1 - (now - fx.hitAt[key]) / 320) : 0);

    renderer.draw({
      ball,
      paddles: sample ? sample.paddles : { p1: null, p2: null },
      players: match.players,
      showTrail: motion && match.status === "playing",
      goalFx,
      hitFx: { p1: hit("p1"), p2: hit("p2") },
    });

    requestAnimationFrame(frame);
  }

  // Telemetria e contagens regressivas: atualizadas poucas vezes por segundo.
  setInterval(() => {
    const now = performance.now();
    while (arrivals.length && arrivals[0] < now - 1000) arrivals.shift();
    els.tmRate.textContent = server.status === "open" && lastStateAt !== null ? String(arrivals.length) : "—";
    els.tmAge.textContent = server.status === "open" && lastStateAt !== null ? formatAge(now - lastStateAt) : "—";
    if (server.status !== "open") els.serverStatusText.textContent = serverStatusText();
    renderOverlay();
  }, UI_TICK_MS);

  function formatAge(ms) {
    if (ms < 1000) return `${Math.round(ms)} ms`;
    if (ms < 60000) return `${Math.round(ms / 1000)} s`;
    return `${Math.round(ms / 60000)} min`;
  }

  // ---- Controles --------------------------------------------------------

  els.btnPrimary.addEventListener("click", () => sendCommand(els.btnPrimary.dataset.action));
  els.btnReset.addEventListener("click", requestReset);
  els.btnInfo.addEventListener("click", () => els.infoDialog.showModal());
  els.btnFullscreen.addEventListener("click", toggleFullscreen);

  // Fecha o diálogo ao clicar fora dele.
  els.infoDialog.addEventListener("click", (e) => {
    if (e.target === els.infoDialog) els.infoDialog.close();
  });

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen?.().catch(() => {});
  }

  document.addEventListener("keydown", (e) => {
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (els.infoDialog.open) return;
    // Espaço em um botão focado já gera "click"; não duplicar.
    if (e.code === "Space" && e.target instanceof HTMLButtonElement) return;

    switch (e.code) {
      case "Space": {
        e.preventDefault();
        const overlayAction = els.overlay.dataset.visible === "true" && !els.overlayAction.hidden;
        if (overlayAction && server.status !== "open") connection.retryNow();
        else if (!els.btnPrimary.disabled) els.btnPrimary.click();
        break;
      }
      case "KeyR":
        if (!els.btnReset.disabled) requestReset();
        break;
      case "KeyF":
        toggleFullscreen();
        break;
      case "KeyI":
        els.infoDialog.showModal();
        break;
    }
  });

  // ---- Início -----------------------------------------------------------

  updateUI();
  layoutArena();
  connection.connect();
  requestAnimationFrame(frame);
})();
