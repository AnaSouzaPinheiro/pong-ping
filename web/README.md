# PONG//DUO — front-end

Camada de apresentação do Pong distribuído. HTML, CSS e JavaScript puros, sem build e sem dependências.
O navegador só desenha o estado enviado pelo servidor Node.js: física, colisões e placar são responsabilidade do servidor.

## Estrutura

```
web/
├── index.html          estrutura da tela (cabeçalho, placar, arena, controles, instruções)
├── style.css           identidade visual (as cores do canvas também vêm daqui)
├── js/
│   ├── protocol.js     formato das mensagens: o único arquivo que conhece o JSON do servidor
│   ├── connection.js   WebSocket único com reconexão automática (espera exponencial)
│   ├── renderer.js     desenho da arena em <canvas>
│   └── game.js         liga as camadas: estado recebido -> HTML + canvas, botões -> comandos
└── dev/
    └── mock-server.js  servidor SIMULADO para testar a interface (não usa os ESP32)
```

## Executar

O `server/server.js` entrega esta pasta e o WebSocket na mesma porta:

```bash
cd ~/pong-distribuido/server
npm install
node server.js
# abra http://localhost:8080  (ou http://<IP do servidor>:8080)
```

A página se conecta ao mesmo endereço de onde foi carregada. Aberta como arquivo (`file://`), usa `ws://localhost:8080`.
Para outro endereço, use `?ws=`, por exemplo `?ws=ws://192.168.0.10:8080`.

### Ver a interface funcionando sem o servidor real

```bash
cd ~/pong-distribuido/web
node dev/mock-server.js
# abra http://localhost:8081/?ws=ws://localhost:8081
```

O mock serve os arquivos e simula uma partida seguindo o protocolo proposto, com raquetes controladas por IA.
No terminal, `1` e `2` conectam ou desconectam cada jogador simulado, e `q` encerra. Ele usa o pacote `ws` já instalado em `server/node_modules`.

## Protocolo proposto

O formato completo está documentado no topo de [`js/protocol.js`](js/protocol.js). Em resumo:

| Direção | Mensagem |
|---|---|
| navegador → servidor | `{"type":"hello","role":"viewer"}` e `{"type":"request_state"}` ao conectar |
| navegador → servidor | `{"type":"command","action":"start" \| "pause" \| "resume" \| "reset"}` |
| servidor → navegador | `{"type":"state", "status", "ball", "paddles", "score", "players", ...}` |
| servidor → navegador | `{"type":"error","message":"..."}` (opcional) |

`status` pode ser `waiting`, `ready`, `playing`, `paused`, `goal` ou `finished`.
`players.p1` e `players.p2` podem ser `connected`, `disconnected` ou `reconnecting`.

Se o servidor adotar outro formato, ajuste só `protocol.js`.

O `server/server.js` implementa esse protocolo.
