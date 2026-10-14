# Pong Distribuído com ESP32

Projeto de Computação Paralela: duas placas ESP32 com acelerômetro MMA8452 controlam as raquetes de um Pong. O servidor Node.js mantém o estado autoritativo da partida e o navegador apenas o desenha.

```
MMA8452 → Task aquisição (core 0) → mutex → Task comunicação (core 1) → Wi-Fi → WebSocket
   → SERVIDOR (estado + motor do jogo) → WebSocket → NAVEGADOR (canvas)
```

## Estrutura

```
pong-ping/
├── esp32/pong_esp32/
│   ├── pong_esp32.ino        firmware único (as duas placas)
│   ├── config.example.h      modelo de configuração
│   └── config.h              configuração local (NÃO versionado)
├── server/server.js          servidor HTTP + WebSocket, motor do jogo
├── web/                      interface (HTML/CSS/JS + canvas), ver web/README.md
└── package.json
```

## Componentes

Por jogador: 1 ESP32 (ESP32-WROOM-32), 1 MMA8452, 1 protoboard, jumpers e cabo USB/powerbank.
Também é preciso um computador ou servidor (AWS) com Node.js 18+.

### Montagem (I2C)

| MMA8452 | ESP32 |
|---|---|
| VCC | 3V3 |
| GND | GND |
| SDA | GPIO 21 |
| SCL | GPIO 22 |
| SA0 | 3V3 (endereço `0x1D`) |

## Firmware (ESP32)

**Bibliotecas:** `Wire.h` e `WiFi.h` (core ESP32) e **WebSockets** de Markus Sattler / Links2004 (instalar pelo Gerenciador de Bibliotecas da Arduino IDE).

**Compilação:**
1. Arduino IDE com o pacote de placas *esp32* (Espressif); placa "ESP32 Dev Module".
2. Copie `esp32/pong_esp32/config.example.h` para `config.h` e preencha o Wi-Fi e o IP/porta do servidor.
3. Defina `PLAYER_ID 1` e grave a placa da raquete esquerda; depois mude para `PLAYER_ID 2` e grave a da direita.
4. Ao ligar, **deixe a protoboard parada em posição de repouso por ~1 s**: é a calibração.

**Tarefas FreeRTOS:**

| Task | Core | Frequência | Papel |
|---|---|---|---|
| `taskAquisicao` | 0 | 100 Hz | inicializa o MMA8452, calibra o repouso, lê X/Y/Z, aplica filtro e zona morta e publica (produtor) |
| `taskComunicacao` | 1 | 25 Hz | Wi-Fi, WebSocket, lê a amostra mais recente e envia; reconecta sozinha (consumidor) |
| `loop()` | 1 | 1 Hz | imprime `[STATS] leituras/s, enviadas/s` no Serial |

**Sincronização:** a última amostra (`struct Amostra`) é compartilhada e protegida por mutex. É um buffer de 1 posição com sobrescrita: se o produtor for mais rápido, as leituras antigas são descartadas, porque só a mais recente importa para a raquete. O mutex é tomado com timeout de 5 ms, então nenhuma task fica presa.

**Falha de rede:** as tasks são criadas antes da conexão. Sem Wi-Fi ou sem servidor, a aquisição continua a 100 Hz (visível no `[STATS]`) e a comunicação tenta reconectar o Wi-Fi a cada 5 s e o WebSocket a cada 2 s.

**Tratamento do sinal:** calibração da posição de repouso (média de 100 leituras), média móvel exponencial (α = 0,25) e zona morta de ±15 contagens. No servidor, a raquete ainda segue o alvo com suavização exponencial.

## Protocolo

**ESP32 → servidor** (um WebSocket por placa):
```json
{"player": 1, "seq": 1502, "t": 2738192, "x": -34, "y": 210, "z": 3}
```
| Campo | Significado |
|---|---|
| `player` | 1 = raquete esquerda, 2 = direita |
| `seq` | número de sequência; buracos indicam mensagens perdidas |
| `t` | `millis()` da leitura no ESP32 |
| `x,y,z` | aceleração filtrada em relação ao repouso (1024 ≈ 1 g) |

**Servidor → navegador** (30 Hz):
```json
{"type":"state","status":"playing","arena":{"width":800,"height":500},
 "ball":{"x":412.3,"y":250.1,"r":8},
 "paddles":{"p1":{"y":240,"h":100},"p2":{"y":260,"h":100}},
 "score":{"p1":2,"p2":1},"players":{"p1":"connected","p2":"connected"},
 "targetScore":5,"winner":null,"countdown":null}
```

**Navegador → servidor:** `{"type":"hello","role":"viewer"}`, `{"type":"request_state"}`, `{"type":"command","action":"start|pause|resume|reset"}`.

## Servidor

```bash
npm install
node server/server.js
```

Uma única porta (8080) serve a interface web, os WebSockets dos ESP32 e os do navegador. Libere a porta no Security Group (AWS) ou no firewall.

| Variável | Padrão | Função |
|---|---|---|
| `PORT` | 8080 | porta HTTP/WebSocket |
| `AXIS` | `y` | eixo que move a raquete |
| `SENSITIVITY` | 600 | inclinação que leva a raquete à borda |
| `INVERT_P1` / `INVERT_P2` | 0 | `1` inverte o sentido |
| `TARGET_SCORE` | 5 | pontos para vencer |

A física roda a 60 Hz e o estado é transmitido a 30 Hz. A cada 2 s o terminal mostra, por jogador, a leitura, as mensagens/s recebidas, o último `seq` e o total de mensagens perdidas.

**Estados da partida:** `waiting → ready → playing ⇄ goal → finished`. Se um ESP32 cair durante o jogo, a partida vai para `paused` e **retoma automaticamente** (com contagem de 3 s) quando os dois voltam. Uma pausa feita pelo botão só sai com "Retomar".

## Execução completa

1. `node server/server.js` no servidor.
2. Ligue os dois ESP32 (parados, para calibrar) e confira no Serial `wifi=ok ws=ok`.
3. Abra `http://<IP do servidor>:8080`; quando os dois aparecerem conectados, clique em **Iniciar**.
4. Fechar o navegador não afeta a partida: ao reabrir, o estado atual é recebido do servidor.
