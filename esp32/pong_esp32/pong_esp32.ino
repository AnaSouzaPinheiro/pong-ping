/*
 * pong_esp32.ino — Firmware único dos controles do Pong distribuído
 *
 * O mesmo código é gravado nas duas placas; só muda PLAYER_ID em config.h.
 *
 *   Core 0: taskAquisicao   (PRODUTOR)  lê o MMA8452 a 100 Hz, calibra e filtra
 *   Core 1: taskComunicacao (CONSUMIDOR) Wi-Fi + WebSocket, envia a 25 Hz
 *
 * Recurso compartilhado: a struct `amostraCompartilhada` (última leitura filtrada),
 * protegida por mutex. É um buffer de 1 posição com sobrescrita: se o produtor
 * for mais rápido que o consumidor, as leituras antigas são descartadas de
 * propósito, porque para mover a raquete só importa a mais recente.
 *
 * A rede nunca bloqueia a aquisição: o Wi-Fi e o WebSocket são tratados apenas
 * na task de comunicação, sem laços de espera, e a seção crítica do mutex só
 * copia alguns bytes.
 *
 * Mensagem enviada (JSON):
 *   {"player":1,"seq":1502,"t":2738192,"x":-34,"y":210,"z":3}
 *   seq = número de sequência (detecta perda), t = millis() da leitura,
 *   x/y/z = aceleração filtrada relativa à posição de repouso (1024 ≈ 1 g).
 */
#include <Wire.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include "config.h"   // PLAYER_ID, WIFI_SSID, WIFI_PASSWORD, SERVER_HOST, SERVER_PORT

// ============================================================
// PARÂMETROS
// ============================================================

#define MMA8452_ADDR 0x1D
#define I2C_SDA 21
#define I2C_SCL 22

const uint32_t AQUISICAO_HZ = 100;      // período de 10 ms: bem acima do que a mão consegue variar
const uint32_t ENVIO_HZ = 25;           // 40 ms: suficiente para o servidor (física a 60 Hz, com suavização)
const int CALIBRACAO_AMOSTRAS = 100;    // ~1 s parado no boot define a posição de repouso
const float FILTRO_ALFA = 0.25f;        // média móvel exponencial (0..1): menor = mais suave
const int16_t ZONA_MORTA = 15;          // |valor| abaixo disso vira 0 (ignora tremor da mão)
const uint32_t WIFI_RETRY_MS = 5000;

// ============================================================
// DADOS COMPARTILHADOS ENTRE AS TASKS
// ============================================================

struct Amostra {
  int16_t x, y, z;     // filtrado e calibrado
  uint32_t t;          // millis() da leitura
  uint32_t numero;     // contador de leituras (0 = ainda não há leitura)
};

Amostra amostraCompartilhada = {0, 0, 0, 0, 0};
SemaphoreHandle_t sensorMutex;

// Contadores para os experimentos (cada um é escrito por uma única task;
// a outra só lê, e leitura de uint32_t alinhado é atômica no ESP32).
volatile uint32_t leiturasOk = 0;
volatile uint32_t leiturasFalhas = 0;
volatile uint32_t mensagensEnviadas = 0;

WebSocketsClient webSocket;

// ============================================================
// MMA8452
// ============================================================

void escreverRegistrador(uint8_t reg, uint8_t valor) {
  Wire.beginTransmission(MMA8452_ADDR);
  Wire.write(reg);
  Wire.write(valor);
  Wire.endTransmission();
}

bool iniciarMMA8452() {
  Wire.beginTransmission(MMA8452_ADDR);
  Wire.write(0x0D);                           // WHO_AM_I
  if (Wire.endTransmission(false) != 0) return false;
  Wire.requestFrom(MMA8452_ADDR, 1);
  if (!Wire.available() || Wire.read() != 0x2A) return false;

  escreverRegistrador(0x2A, 0x00);            // standby para configurar
  escreverRegistrador(0x0E, 0x00);            // escala ±2 g (1024 contagens/g)
  escreverRegistrador(0x2A, 0x01);            // ativo, ODR padrão 800 Hz
  return true;
}

// Retorna false se a leitura I2C falhar (os valores não são alterados).
bool lerAcelerometro(int16_t &x, int16_t &y, int16_t &z) {
  Wire.beginTransmission(MMA8452_ADDR);
  Wire.write(0x01);                           // OUT_X_MSB
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom(MMA8452_ADDR, 6) != 6) return false;

  uint8_t b[6];
  for (int i = 0; i < 6; i++) b[i] = Wire.read();
  x = (int16_t)((b[0] << 8) | b[1]) >> 4;     // 12 bits com sinal
  y = (int16_t)((b[2] << 8) | b[3]) >> 4;
  z = (int16_t)((b[4] << 8) | b[5]) >> 4;
  return true;
}

int16_t aplicarZonaMorta(float v) {
  if (v > -ZONA_MORTA && v < ZONA_MORTA) return 0;
  return (int16_t)v;
}

// ============================================================
// TASK 1 — AQUISIÇÃO (PRODUTOR) — CORE 0
// ============================================================

void taskAquisicao(void *parameter) {
  Serial.printf("[AQUISICAO] iniciada no core %d\n", xPortGetCoreID());

  while (!iniciarMMA8452()) {
    Serial.println("[AQUISICAO] MMA8452 nao encontrado, tentando de novo...");
    vTaskDelay(pdMS_TO_TICKS(1000));
  }

  // Calibração: média das leituras com a protoboard parada na posição de repouso.
  Serial.println("[AQUISICAO] calibrando: mantenha a protoboard parada...");
  long somaX = 0, somaY = 0, somaZ = 0;
  int validas = 0;
  while (validas < CALIBRACAO_AMOSTRAS) {
    int16_t x, y, z;
    if (lerAcelerometro(x, y, z)) {
      somaX += x; somaY += y; somaZ += z;
      validas++;
    }
    vTaskDelay(pdMS_TO_TICKS(10));
  }
  const float repousoX = (float)somaX / validas;
  const float repousoY = (float)somaY / validas;
  const float repousoZ = (float)somaZ / validas;
  Serial.printf("[AQUISICAO] repouso: x=%.0f y=%.0f z=%.0f\n", repousoX, repousoY, repousoZ);

  float fx = 0, fy = 0, fz = 0;
  uint32_t numero = 0;
  TickType_t proximo = xTaskGetTickCount();

  while (true) {
    int16_t x, y, z;
    if (lerAcelerometro(x, y, z)) {
      // Filtro passa-baixa (média móvel exponencial) sobre o desvio do repouso.
      fx += FILTRO_ALFA * ((x - repousoX) - fx);
      fy += FILTRO_ALFA * ((y - repousoY) - fy);
      fz += FILTRO_ALFA * ((z - repousoZ) - fz);

      Amostra nova = {aplicarZonaMorta(fx), aplicarZonaMorta(fy), aplicarZonaMorta(fz),
                      millis(), ++numero};

      // Seção crítica curta: só a cópia da struct. Timeout em vez de espera
      // infinita: no pior caso perde-se uma amostra, nunca trava a task.
      if (xSemaphoreTake(sensorMutex, pdMS_TO_TICKS(5)) == pdTRUE) {
        amostraCompartilhada = nova;
        xSemaphoreGive(sensorMutex);
      }
      leiturasOk++;
    } else {
      leiturasFalhas++;
    }

    vTaskDelayUntil(&proximo, pdMS_TO_TICKS(1000 / AQUISICAO_HZ));  // período fixo
  }
}

// ============================================================
// TASK 2 — COMUNICAÇÃO (CONSUMIDOR) — CORE 1
// ============================================================

void eventoWebSocket(WStype_t tipo, uint8_t *payload, size_t length) {
  if (tipo == WStype_CONNECTED) Serial.println("[COMUNICACAO] WebSocket conectado");
  else if (tipo == WStype_DISCONNECTED) Serial.println("[COMUNICACAO] WebSocket desconectado");
}

void taskComunicacao(void *parameter) {
  Serial.printf("[COMUNICACAO] iniciada no core %d\n", xPortGetCoreID());

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);   // não bloqueia: o estado é verificado no laço

  bool wsIniciado = false;
  bool wifiAnterior = false;
  uint32_t ultimaTentativaWifi = millis();
  uint32_t seq = 0;
  TickType_t proximo = xTaskGetTickCount();

  while (true) {
    const bool wifiOk = WiFi.status() == WL_CONNECTED;

    if (wifiOk != wifiAnterior) {
      if (wifiOk) Serial.printf("[COMUNICACAO] Wi-Fi conectado, IP %s\n", WiFi.localIP().toString().c_str());
      else Serial.println("[COMUNICACAO] Wi-Fi perdido, tentando reconectar...");
      wifiAnterior = wifiOk;
    }

    if (!wifiOk) {
      // Recuperação do Wi-Fi sem travar: nova tentativa a cada WIFI_RETRY_MS.
      if (millis() - ultimaTentativaWifi >= WIFI_RETRY_MS) {
        ultimaTentativaWifi = millis();
        WiFi.disconnect();
        WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
      }
    } else {
      if (!wsIniciado) {
        webSocket.begin(SERVER_HOST, SERVER_PORT, "/");
        webSocket.onEvent(eventoWebSocket);
        webSocket.setReconnectInterval(2000);       // a biblioteca reconecta sozinha
        webSocket.enableHeartbeat(5000, 2000, 2);   // detecta conexão morta (ping/pong)
        wsIniciado = true;
      }
      webSocket.loop();

      // Consome a amostra mais recente (cópia rápida dentro da seção crítica).
      Amostra a;
      bool temAmostra = false;
      if (xSemaphoreTake(sensorMutex, pdMS_TO_TICKS(5)) == pdTRUE) {
        a = amostraCompartilhada;
        xSemaphoreGive(sensorMutex);
        temAmostra = a.numero != 0;
      }

      if (temAmostra && webSocket.isConnected()) {
        char msg[128];
        snprintf(msg, sizeof(msg),
                 "{\"player\":%d,\"seq\":%lu,\"t\":%lu,\"x\":%d,\"y\":%d,\"z\":%d}",
                 PLAYER_ID, (unsigned long)++seq, (unsigned long)a.t, a.x, a.y, a.z);
        if (webSocket.sendTXT(msg)) mensagensEnviadas++;
      }
    }

    vTaskDelayUntil(&proximo, pdMS_TO_TICKS(1000 / ENVIO_HZ));
  }
}

// ============================================================
// SETUP / LOOP
// ============================================================

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.printf("\n=== ESP32 #%d - PONG DISTRIBUIDO ===\n", PLAYER_ID);

  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000);

  sensorMutex = xSemaphoreCreateMutex();
  if (sensorMutex == NULL) {
    Serial.println("ERRO: nao foi possivel criar o mutex!");
    while (true) delay(1000);
  }

  // As tasks são criadas ANTES de qualquer conexão de rede: a aquisição
  // começa mesmo que o Wi-Fi ou o servidor estejam fora do ar.
  // Prioridade maior para a aquisição (requisito temporal mais crítico).
  xTaskCreatePinnedToCore(taskAquisicao, "TaskAquisicao", 4096, NULL, 2, NULL, 0);
  xTaskCreatePinnedToCore(taskComunicacao, "TaskComunicacao", 8192, NULL, 1, NULL, 1);
}

// Estatísticas a cada 1 s (Experimentos 1, 2 e 4): leituras/s e mensagens/s.
void loop() {
  static uint32_t leiturasAntes = 0, enviadasAntes = 0;
  delay(1000);
  const uint32_t l = leiturasOk, e = mensagensEnviadas;
  Serial.printf("[STATS] leituras/s=%lu  enviadas/s=%lu  falhas_i2c=%lu  wifi=%s  ws=%s\n",
                (unsigned long)(l - leiturasAntes), (unsigned long)(e - enviadasAntes),
                (unsigned long)leiturasFalhas,
                WiFi.status() == WL_CONNECTED ? "ok" : "off",
                webSocket.isConnected() ? "ok" : "off");
  leiturasAntes = l;
  enviadasAntes = e;
}
