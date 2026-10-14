/*
 * connection.js — Camada de transporte (WebSocket)
 *
 * Mantém UMA única conexão com o servidor, reconecta automaticamente com
 * espera exponencial e entrega as mensagens já interpretadas por protocol.js.
 * Não conhece nada da interface: apenas emite eventos.
 *
 * Eventos (via on(nome, fn)):
 *   "status"  -> { status, attempt, retryInMs }
 *                status: "connecting" | "open" | "reconnecting"
 *   "message" -> mensagem retornada por PongProtocol.parseServerMessage()
 */
(function () {
  "use strict";

  const RETRY_BASE_MS = 1000;
  const RETRY_MAX_MS = 10000;

  class PongConnection {
    constructor(url) {
      this.url = url;
      this.socket = null;
      this.status = "connecting";
      this.attempt = 0;
      this.retryTimer = null;
      this.listeners = {};
    }

    on(name, fn) {
      (this.listeners[name] ||= []).push(fn);
    }

    emit(name, payload) {
      for (const fn of this.listeners[name] || []) fn(payload);
    }

    setStatus(status, extra = {}) {
      this.status = status;
      this.emit("status", { status, attempt: this.attempt, ...extra });
    }

    connect() {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;

      // Garante que nunca existam duas conexões abertas ao mesmo tempo.
      if (this.socket) {
        this.socket.onopen = this.socket.onmessage = this.socket.onclose = this.socket.onerror = null;
        this.socket.close();
        this.socket = null;
      }

      this.setStatus(this.attempt === 0 ? "connecting" : "reconnecting");

      let socket;
      try {
        socket = new WebSocket(this.url);
      } catch (err) {
        // URL inválida, por exemplo. Tenta de novo mais tarde.
        this.scheduleRetry();
        return;
      }
      this.socket = socket;

      socket.onopen = () => {
        this.attempt = 0;
        this.setStatus("open");
        // Identifica o navegador e pede o estado atual (requisito de reconexão).
        this.send(PongProtocol.outgoing.hello());
        this.send(PongProtocol.outgoing.requestState());
      };

      socket.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        const message = PongProtocol.parseServerMessage(event.data);
        if (message) this.emit("message", message);
      };

      // "error" é sempre seguido de "close"; a reconexão é tratada lá.
      socket.onerror = () => {};

      socket.onclose = () => {
        if (this.socket !== socket) return;
        this.socket = null;
        this.scheduleRetry();
      };
    }

    scheduleRetry() {
      this.attempt += 1;
      const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (this.attempt - 1));
      const jitter = delay * 0.2 * Math.random();
      const retryInMs = Math.round(delay + jitter);
      this.setStatus("reconnecting", { retryInMs, retryAt: performance.now() + retryInMs });
      this.retryTimer = setTimeout(() => this.connect(), retryInMs);
    }

    /** Força uma tentativa imediata (botão "Tentar agora"). */
    retryNow() {
      if (this.status !== "open") this.connect();
    }

    /** Envia um objeto como JSON. Retorna false se a conexão não estiver aberta. */
    send(obj) {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
      this.socket.send(JSON.stringify(obj));
      return true;
    }
  }

  window.PongConnection = PongConnection;
})();
