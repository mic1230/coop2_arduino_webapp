#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WebServer.h>
#include <esp_wifi.h>
#include <esp32-hal-adc.h>
#include <OneWire.h>
#include <DallasTemperature.h>

#include "web_assets.h"

//==============================================================================
// Network configuration (ported from MicroPython wifi_connect)
//==============================================================================
struct NetworkCredential {
  const char *ssid;
  const char *password;
};

struct NetworkCandidate {
  const NetworkCredential *credential;
  int32_t rssi;
};

constexpr NetworkCredential WIFI_NETWORKS[] = {
    {"RPMOLDOVA_EXT", "Mi22021987"},
    {"Mircea's Wi-Fi Network", "Mi22021987"},
};
constexpr size_t WIFI_NETWORK_COUNT = sizeof(WIFI_NETWORKS) / sizeof(WIFI_NETWORKS[0]);

const IPAddress PING_ADDRESS(8, 8, 8, 8);
constexpr uint16_t PING_PORT = 53;
constexpr uint8_t MAX_RETRIES = 3;
constexpr uint8_t STATUS_CHECK_ITERATIONS = 10;
constexpr uint32_t STATUS_CHECK_DELAY_MS = 5000;
constexpr uint32_t INTERNET_CHECK_TIMEOUT_MS = 5000;

bool checkInternet();
size_t collectConfiguredNetworks(NetworkCandidate *candidates, size_t maxCandidates);
void sortCandidates(NetworkCandidate *candidates, size_t count);
bool connectToWifi();

//==============================================================================
// Door control (ported from MicroPython open_door / close_door)
//==============================================================================
constexpr uint8_t RELAY_OPEN_PIN = 19;   // Relay that drives the OPEN direction
constexpr uint8_t RELAY_CLOSE_PIN = 17;  // Relay that drives the CLOSE direction
constexpr uint32_t DOOR_TRAVEL_TIME_MS = 5000;
constexpr bool RELAY_ACTIVE_STATE = LOW;
constexpr bool RELAY_IDLE_STATE = HIGH;
constexpr bool TEST_MODE = true;  // When true, relays are not driven; logs only.
constexpr bool VERBOSE_LOGS = false;

//==============================================================================
// Sensor configuration (ported from MicroPython get_sensor_readings)
//==============================================================================
constexpr uint8_t DS18B20_PIN = 20;
constexpr uint8_t BATTERY_ADC_PIN = 1;  // Matches MicroPython's ADC Pin 1
constexpr float ADC_REFERENCE_VOLTS = 3.3f;
constexpr float VOLTAGE_DIVIDER_RATIO = 0.8333f;  // 10k / (10k + 2k)
constexpr uint16_t SENSOR_CONVERSION_DELAY_MS = 750;

OneWire onewireBus(DS18B20_PIN);
DallasTemperature temperatureBus(&onewireBus);

const DeviceAddress BATTERY_TEMP_ADDRESS = {0x28, 0xA5, 0x35, 0x57, 0x04, 0xE1, 0x3C, 0x93};
const DeviceAddress GREENHOUSE_TEMP_ADDRESS = {0x28, 0x66, 0x11, 0x57, 0x04, 0xE1, 0x3C, 0xB2};

struct SensorReadings {
  bool hasBatteryTemp = false;
  float batteryTempC = 0.0f;
  bool hasGreenhouseTemp = false;
  float greenhouseTempC = 0.0f;
  bool hasBatteryVoltage = false;
  float batteryVoltage = 0.0f;
};

void initTemperatureSensors();
void initBatteryAdc();
bool readTemperature(const DeviceAddress address, const char *label, float &valueOut);
SensorReadings getSensorReadings();
void logSensorReadings();
bool serveEmbeddedAsset(WebServer &server, const String &requestPath);
void handleWebIndex();

WebServer apiServer(80);
bool apiServerEnabled = false;

Preferences doorPrefs;
constexpr char PREF_NAMESPACE[] = "coopdoor";
constexpr char PREF_KEY_STATE[] = "state";

enum class DoorState : uint8_t { Closed, Opened };

enum class DoorMotion : uint8_t { Idle, Opening, Closing };

enum class DoorCommandResult : uint8_t { Accepted, AlreadyAtTarget, Busy };

struct DoorMotionController {
  DoorMotion motion = DoorMotion::Idle;
  DoorState targetState = DoorState::Closed;
  uint32_t motionStartMs = 0;
};

DoorMotionController doorMotion;

const char *doorStateToString(DoorState state) {
  return state == DoorState::Opened ? "opened" : "closed";
}

DoorState doorStateFromString(const String &value) {
  return value == "opened" ? DoorState::Opened : DoorState::Closed;
}

void initDoorHardware() {
  if (TEST_MODE) {
    Serial.println("TEST MODE: Door relays not initialized; hardware outputs disabled.");
    return;
  }

  pinMode(RELAY_OPEN_PIN, OUTPUT);
  pinMode(RELAY_CLOSE_PIN, OUTPUT);
  digitalWrite(RELAY_OPEN_PIN, RELAY_IDLE_STATE);
  digitalWrite(RELAY_CLOSE_PIN, RELAY_IDLE_STATE);
  Serial.println("Door relays initialized (active-low).");
}

bool initDoorPreferences() {
  static bool initialized = false;
  if (initialized) {
    return true;
  }
  initialized = doorPrefs.begin(PREF_NAMESPACE, false);
  if (!initialized) {
    Serial.println("Failed to open Preferences storage; door state will not persist.");
  } else {
    Serial.println("Door state storage ready.");
  }
  return initialized;
}

DoorState getDoorPosition() {
  if (!initDoorPreferences()) {
    return DoorState::Closed;
  }
  const String stored = doorPrefs.getString(PREF_KEY_STATE, "closed");
  const DoorState state = doorStateFromString(stored);
  return state;
}

void setDoorPosition(DoorState state) {
  if (!initDoorPreferences()) {
    Serial.println("Unable to persist door state (prefs unavailable).");
    return;
  }
  doorPrefs.putString(PREF_KEY_STATE, doorStateToString(state));
}

const char *doorMotionToString(DoorMotion motion) {
  switch (motion) {
    case DoorMotion::Opening:
      return "opening";
    case DoorMotion::Closing:
      return "closing";
    default:
      return "idle";
  }
}

const char *doorCommandResultToString(DoorCommandResult result) {
  switch (result) {
    case DoorCommandResult::Accepted:
      return "accepted";
    case DoorCommandResult::AlreadyAtTarget:
      return "already_at_target";
    case DoorCommandResult::Busy:
      return "busy";
  }
  return "unknown";
}

void logDoorStatusIfChanged(const __FlashStringHelper *tag, DoorState persistedState) {
  static bool initialized = false;
  static DoorState lastState = DoorState::Closed;
  static DoorMotion lastMotion = DoorMotion::Idle;
  static bool lastBusy = false;

  const DoorMotion motion = doorMotion.motion;
  const bool busy = motion != DoorMotion::Idle;

  if (!initialized || persistedState != lastState || motion != lastMotion || busy != lastBusy) {
    Serial.print(F("[door] "));
    if (tag != nullptr) {
      Serial.print(tag);
      Serial.print(F(" "));
    }
    Serial.print(F("state="));
    Serial.print(doorStateToString(persistedState));
    Serial.print(F(" motion="));
    Serial.print(doorMotionToString(motion));
    Serial.print(F(" busy="));
    Serial.print(busy ? F("true") : F("false"));
    if (busy) {
      Serial.print(F(" target="));
      Serial.print(doorStateToString(doorMotion.targetState));
    }
    Serial.println();

    lastState = persistedState;
    lastMotion = motion;
    lastBusy = busy;
    initialized = true;
  }
}

void logDoorStatusIfChanged(const __FlashStringHelper *tag) {
  logDoorStatusIfChanged(tag, getDoorPosition());
}

uint8_t relayPinForMotion(DoorMotion motion) {
  return motion == DoorMotion::Opening ? RELAY_OPEN_PIN : RELAY_CLOSE_PIN;
}

void setRelayState(uint8_t pin, bool active) {
  if (pin == 0) {
    return;
  }
  if (TEST_MODE) {
    Serial.printf("TEST MODE: Relay pin %u -> %s.\n", pin, active ? "ACTIVE" : "IDLE");
    return;
  }
  digitalWrite(pin, active ? RELAY_ACTIVE_STATE : RELAY_IDLE_STATE);
}

void stopAllRelays() {
  setRelayState(RELAY_OPEN_PIN, false);
  setRelayState(RELAY_CLOSE_PIN, false);
}

bool beginDoorMotion(DoorMotion motion) {
  if (doorMotion.motion != DoorMotion::Idle) {
    Serial.printf("Rejecting %s request - door already %s.\n", doorMotionToString(motion),
                  doorMotionToString(doorMotion.motion));
    return false;
  }
  doorMotion.motion = motion;
  doorMotion.motionStartMs = millis();
  doorMotion.targetState = motion == DoorMotion::Opening ? DoorState::Opened : DoorState::Closed;
  stopAllRelays();
  setRelayState(relayPinForMotion(motion), true);
  logDoorStatusIfChanged(F("motion_start"));
  return true;
}

void completeDoorMotion() {
  if (doorMotion.motion == DoorMotion::Idle) {
    return;
  }
  stopAllRelays();
  setDoorPosition(doorMotion.targetState);
  doorMotion.motion = DoorMotion::Idle;
  doorMotion.motionStartMs = 0;
  logDoorStatusIfChanged(F("motion_complete"), doorMotion.targetState);
}

void updateDoorMotion() {
  if (doorMotion.motion == DoorMotion::Idle) {
    return;
  }
  const uint32_t elapsed = millis() - doorMotion.motionStartMs;
  if (elapsed >= DOOR_TRAVEL_TIME_MS) {
    completeDoorMotion();
  }
}

DoorCommandResult openDoor() {
  if (doorMotion.motion != DoorMotion::Idle) {
    Serial.println("Open door command ignored - motion already in progress.");
    return DoorCommandResult::Busy;
  }
  const DoorState current = getDoorPosition();
  if (current == DoorState::Opened) {
    Serial.println("Door already opened - no action taken.");
    return DoorCommandResult::AlreadyAtTarget;
  }
  if (beginDoorMotion(DoorMotion::Opening)) {
    return DoorCommandResult::Accepted;
  }
  return DoorCommandResult::Busy;
}

DoorCommandResult closeDoor() {
  if (doorMotion.motion != DoorMotion::Idle) {
    Serial.println("Close door command ignored - motion already in progress.");
    return DoorCommandResult::Busy;
  }
  const DoorState current = getDoorPosition();
  if (current == DoorState::Closed) {
    Serial.println("Door already closed - no action taken.");
    return DoorCommandResult::AlreadyAtTarget;
  }
  if (beginDoorMotion(DoorMotion::Closing)) {
    return DoorCommandResult::Accepted;
  }
  return DoorCommandResult::Busy;
}

//==============================================================================
// Sensor helpers
//==============================================================================
void initTemperatureSensors() {
  static bool initialized = false;
  if (initialized) {
    return;
  }
  temperatureBus.begin();
  temperatureBus.setWaitForConversion(false);
  if (VERBOSE_LOGS) {
    Serial.printf("DS18B20 bus initialized on pin %u.\n", DS18B20_PIN);
  }
  initialized = true;
}

void initBatteryAdc() {
  static bool configured = false;
  if (configured) {
    return;
  }
  pinMode(BATTERY_ADC_PIN, INPUT);
  analogReadResolution(12);
#if defined(ADC_11db) && defined(analogSetPinAttenuation)
  analogSetPinAttenuation(BATTERY_ADC_PIN, ADC_11db);
#endif
  if (VERBOSE_LOGS) {
    Serial.printf("Battery ADC configured on pin %u.\n", BATTERY_ADC_PIN);
  }
  configured = true;
}

bool readTemperature(const DeviceAddress address, const char *label, float &valueOut) {
  const float tempC = temperatureBus.getTempC(address);
  if (tempC == DEVICE_DISCONNECTED_C) {
    if (VERBOSE_LOGS) {
      Serial.printf("Failed to read %s temperature (sensor disconnected?).\n", label);
    }
    return false;
  }
  valueOut = tempC;
  if (VERBOSE_LOGS) {
    Serial.printf("%s temperature: %.2f C\n", label, tempC);
  }
  return true;
}

SensorReadings getSensorReadings() {
  SensorReadings readings;
  initTemperatureSensors();
  if (VERBOSE_LOGS) {
    Serial.println("Requesting DS18B20 temperature readings...");
  }
  temperatureBus.requestTemperatures();
  delay(SENSOR_CONVERSION_DELAY_MS);

  readings.hasBatteryTemp = readTemperature(BATTERY_TEMP_ADDRESS, "Battery", readings.batteryTempC);
  readings.hasGreenhouseTemp =
      readTemperature(GREENHOUSE_TEMP_ADDRESS, "Greenhouse", readings.greenhouseTempC);

  initBatteryAdc();
  const int raw = analogRead(BATTERY_ADC_PIN);
  if (raw >= 0) {
    if (VERBOSE_LOGS) {
      Serial.printf("Battery ADC raw value: %d\n", raw);
    }
    const float adcVoltage = (static_cast<float>(raw) / 4095.0f) * ADC_REFERENCE_VOLTS;
    const float correctedVoltage = adcVoltage / VOLTAGE_DIVIDER_RATIO;
    readings.hasBatteryVoltage = true;
    readings.batteryVoltage = correctedVoltage;
    if (VERBOSE_LOGS) {
      Serial.printf("Battery voltage: %.2f V (ADC %.2f V before divider correction).\n",
                    correctedVoltage, adcVoltage);
    }
  } else {
    if (VERBOSE_LOGS) {
      Serial.println("Error reading battery voltage (analogRead returned invalid value).");
    }
  }

  return readings;
}

void logSensorReadings() {
  if (!VERBOSE_LOGS) {
    return;
  }
  const SensorReadings readings = getSensorReadings();
  if (!readings.hasBatteryTemp) {
    Serial.println("Battery temperature reading unavailable.");
  }
  if (!readings.hasGreenhouseTemp) {
    Serial.println("Greenhouse temperature reading unavailable.");
  }
  if (!readings.hasBatteryVoltage) {
    Serial.println("Battery voltage reading unavailable.");
  }
}

//==============================================================================
// Embedded web UI helpers
//==============================================================================
const EmbeddedAsset *findEmbeddedAsset(const String &requestPath) {
  String normalized = requestPath;
  if (normalized.length() == 0 || normalized == "/") {
    normalized = F("/index.html");
  } else if (!normalized.startsWith("/")) {
    normalized = "/" + normalized;
  }

  for (size_t idx = 0; idx < EMBEDDED_ASSET_COUNT; ++idx) {
    if (normalized == EMBEDDED_ASSETS[idx].path) {
      return &EMBEDDED_ASSETS[idx];
    }
  }
  return nullptr;
}

bool serveEmbeddedAsset(WebServer &server, const String &requestPath) {
  const EmbeddedAsset *asset = findEmbeddedAsset(requestPath);
  if (asset == nullptr) {
    return false;
  }

  const bool isIndex = String(asset->path) == F("/index.html");
  server.sendHeader(F("Cache-Control"),
                    isIndex ? F("no-cache, no-store, must-revalidate")
                            : F("public, max-age=2592000, immutable"));
  server.send_P(200, asset->contentType, reinterpret_cast<const char *>(asset->data), asset->size);
  return true;
}

void handleWebIndex() {
  const String indexPath(F("/index.html"));
  if (!serveEmbeddedAsset(apiServer, indexPath)) {
    apiServer.send(500, F("text/plain"), F("Web UI bundle unavailable."));
  }
}

//==============================================================================
// API server
//==============================================================================
String escapeJson(const String &value) {
  String escaped;
  escaped.reserve(value.length() + 4);
  for (size_t idx = 0; idx < static_cast<size_t>(value.length()); ++idx) {
    const char ch = value.charAt(idx);
    switch (ch) {
      case '"':
      case '\\':
        escaped += '\\';
        escaped += ch;
        break;
      case '\b':
        escaped += F("\\b");
        break;
      case '\f':
        escaped += F("\\f");
        break;
      case '\n':
        escaped += F("\\n");
        break;
      case '\r':
        escaped += F("\\r");
        break;
      case '\t':
        escaped += F("\\t");
        break;
      default:
        escaped += ch;
        break;
    }
  }
  return escaped;
}

String sensorReadingsToJson(const SensorReadings &readings) {
  String json;
  json.reserve(256);
  json += F("{\"batteryTempC\":");
  json += readings.hasBatteryTemp ? String(readings.batteryTempC, 2) : F("null");
  json += F(",\"greenhouseTempC\":");
  json += readings.hasGreenhouseTemp ? String(readings.greenhouseTempC, 2) : F("null");
  json += F(",\"batteryVoltage\":");
  json += readings.hasBatteryVoltage ? String(readings.batteryVoltage, 2) : F("null");
  json += F("}");
  return json;
}

String doorStatusToJson(DoorState persistedState) {
  const DoorMotion motion = doorMotion.motion;
  const bool busy = motion != DoorMotion::Idle;
  const DoorState target = busy ? doorMotion.targetState : persistedState;
  uint32_t remainingMs = 0;
  if (busy) {
    const uint32_t elapsed = millis() - doorMotion.motionStartMs;
    if (elapsed >= DOOR_TRAVEL_TIME_MS) {
      remainingMs = 0;
    } else {
      remainingMs = DOOR_TRAVEL_TIME_MS - elapsed;
    }
  }
  String json;
  json.reserve(192);
  json += F("{\"state\":\"");
  json += doorStateToString(persistedState);
  json += F("\",\"motion\":\"");
  json += doorMotionToString(motion);
  json += F("\",\"targetState\":");
  if (busy) {
    json += '"';
    json += doorStateToString(target);
    json += '"';
  } else {
    json += F("null");
  }
  json += F(",\"busy\":");
  json += busy ? F("true") : F("false");
  json += F(",\"testMode\":");
  json += TEST_MODE ? F("true") : F("false");
  json += F(",\"motionRemainingMs\":");
  if (busy) {
    json += String(remainingMs);
  } else {
    json += F("null");
  }
  json += F(",\"travelTimeMs\":");
  json += String(DOOR_TRAVEL_TIME_MS);
  json += F(",\"uptimeMs\":");
  json += String(millis());
  json += F("}");
  return json;
}

String wifiStatusToJson() {
  if (WiFi.status() != WL_CONNECTED) {
    return String(F("null"));
  }
  String json;
  json.reserve(160);
  json += F("{\"ssid\":\"");
  json += escapeJson(WiFi.SSID());
  json += F("\",\"ip\":\"");
  json += WiFi.localIP().toString();
  json += F("\",\"rssi\":");
  json += String(WiFi.RSSI());
  json += F("}");
  return json;
}

void sendCorsHeaders() {
  apiServer.sendHeader(F("Access-Control-Allow-Origin"), F("*"));
  apiServer.sendHeader(F("Access-Control-Allow-Methods"), F("GET,POST,OPTIONS"));
  apiServer.sendHeader(F("Access-Control-Allow-Headers"), F("Content-Type"));
}

void sendJsonResponse(int statusCode, const String &body) {
  sendCorsHeaders();
  apiServer.send(statusCode, F("application/json"), body);
}

void handleOptions() {
  sendCorsHeaders();
  apiServer.send(204, F("text/plain"), "");
}

void handleApiRoot() {
  String json = F("{\"service\":\"coop-door\",\"endpoints\":[\"/api/status\",\"/api/door\","
                  "\"/api/door/open\",\"/api/door/close\",\"/api/sensors\"]}");
  sendJsonResponse(200, json);
}

void handleDoorStatus() {
  sendJsonResponse(200, doorStatusToJson(getDoorPosition()));
}

void handleSensorsEndpoint() {
  const SensorReadings readings = getSensorReadings();
  sendJsonResponse(200, sensorReadingsToJson(readings));
}

String doorCommandResponseToJson(const __FlashStringHelper *actionLabel, DoorCommandResult result) {
  const DoorState state = getDoorPosition();
  String json;
  json.reserve(256);
  json += F("{\"action\":\"");
  json += actionLabel;
  json += F("\",\"result\":\"");
  json += doorCommandResultToString(result);
  json += F("\",\"door\":");
  json += doorStatusToJson(state);
  json += F("}");
  return json;
}

void handleDoorOpen() {
  const DoorCommandResult result = openDoor();
  sendJsonResponse(200, doorCommandResponseToJson(F("open"), result));
}

void handleDoorClose() {
  const DoorCommandResult result = closeDoor();
  sendJsonResponse(200, doorCommandResponseToJson(F("close"), result));
}

void handleStatusEndpoint() {
  const DoorState state = getDoorPosition();
  const SensorReadings readings = getSensorReadings();
  String json;
  json.reserve(320);
  json += F("{\"door\":");
  json += doorStatusToJson(state);
  json += F(",\"sensors\":");
  json += sensorReadingsToJson(readings);
  json += F(",\"wifi\":");
  json += wifiStatusToJson();
  json += F("}");
  sendJsonResponse(200, json);
}

void handleNotFound() {
  if (serveEmbeddedAsset(apiServer, apiServer.uri())) {
    return;
  }
  String json;
  json.reserve(160);
  json += F("{\"error\":\"not_found\",\"path\":\"");
  json += escapeJson(apiServer.uri());
  json += F("\"}");
  sendJsonResponse(404, json);
}

void startApiServer() {
  apiServer.on("/", HTTP_GET, handleWebIndex);
  apiServer.on("/index.html", HTTP_GET, handleWebIndex);
  apiServer.on("/api", HTTP_GET, handleApiRoot);
  apiServer.on("/api/", HTTP_GET, handleApiRoot);
  apiServer.on("/api/status", HTTP_GET, handleStatusEndpoint);
  apiServer.on("/api/sensors", HTTP_GET, handleSensorsEndpoint);
  apiServer.on("/api/door", HTTP_GET, handleDoorStatus);
  apiServer.on("/api/door/open", HTTP_OPTIONS, handleOptions);
  apiServer.on("/api/door/open", HTTP_POST, handleDoorOpen);
  apiServer.on("/api/door/close", HTTP_OPTIONS, handleOptions);
  apiServer.on("/api/door/close", HTTP_POST, handleDoorClose);
  apiServer.onNotFound(handleNotFound);
  apiServer.begin();
  apiServerEnabled = true;
  if (VERBOSE_LOGS) {
    Serial.println("HTTP API server started on port 80.");
  }
}

//==============================================================================
// Arduino entry points
//==============================================================================
void setup() {
  Serial.begin(115200);
  while (!Serial) {
    // wait for serial port to connect (needed for native USB ports)
  }
  Serial.println("Booting coop door controller...");

  initDoorHardware();
  const DoorState bootState = getDoorPosition();
  Serial.printf("Boot-time door position: %s.\n", doorStateToString(bootState));
  logDoorStatusIfChanged(F("boot"), bootState);

  const bool wifiReady = connectToWifi();
  if (wifiReady) {
    Serial.print("Wi-Fi ready. IP address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Wi-Fi unavailable; API calls will be skipped.");
  }

  logSensorReadings();

  if (wifiReady) {
    startApiServer();
  }
}

void loop() {
  updateDoorMotion();
  if (apiServerEnabled) {
    apiServer.handleClient();
  }
  delay(10);
}

//==============================================================================
// Wi-Fi helpers
//==============================================================================
bool checkInternet() {
  WiFiClient client;
  if (VERBOSE_LOGS) {
    Serial.println("Checking internet reachability...");
  }
  if (!client.connect(PING_ADDRESS, PING_PORT, INTERNET_CHECK_TIMEOUT_MS)) {
    if (VERBOSE_LOGS) {
      Serial.println("Internet check failed.");
    }
    return false;
  }
  client.stop();
  if (VERBOSE_LOGS) {
    Serial.println("Internet connection confirmed.");
  }
  return true;
}

size_t collectConfiguredNetworks(NetworkCandidate *candidates, size_t maxCandidates) {
  if (VERBOSE_LOGS) {
    Serial.println("Scanning for Wi-Fi networks...");
  }
  const int16_t found = WiFi.scanNetworks(/*async=*/false, /*hidden=*/true);
  if (found <= 0) {
    if (VERBOSE_LOGS) {
      Serial.println("Wi-Fi scan returned no networks or failed.");
    }
    return 0;
  }

  size_t count = 0;
  for (int16_t i = 0; i < found && count < maxCandidates; ++i) {
    const String ssid = WiFi.SSID(i);
    const int32_t rssi = WiFi.RSSI(i);
    for (size_t credIdx = 0; credIdx < WIFI_NETWORK_COUNT && count < maxCandidates; ++credIdx) {
      if (ssid == WIFI_NETWORKS[credIdx].ssid) {
        candidates[count].credential = &WIFI_NETWORKS[credIdx];
        candidates[count].rssi = rssi;
        ++count;
      }
    }
  }

  if (VERBOSE_LOGS) {
    if (count == 0) {
      Serial.println("No configured Wi-Fi networks found.");
    } else {
      Serial.print("Available networks: ");
      for (size_t idx = 0; idx < count; ++idx) {
        Serial.printf("%s (%ddBm)%s", candidates[idx].credential->ssid, candidates[idx].rssi,
                      idx + 1 < count ? ", " : "\n");
      }
    }
  }
  return count;
}

void sortCandidates(NetworkCandidate *candidates, size_t count) {
  // Simple selection sort since the list is tiny
  for (size_t i = 0; i + 1 < count; ++i) {
    size_t best = i;
    for (size_t j = i + 1; j < count; ++j) {
      if (candidates[j].rssi > candidates[best].rssi) {
        best = j;
      }
    }
    if (best != i) {
      const NetworkCandidate temp = candidates[i];
      candidates[i] = candidates[best];
      candidates[best] = temp;
    }
  }
}

bool connectToWifi() {
  WiFi.mode(WIFI_STA);
  WiFi.persistent(false);
  WiFi.disconnect(true);
  delay(100);

  const esp_err_t txPowerResult = esp_wifi_set_max_tx_power(8 * 4);  // API expects quarter-dBm units
  if (txPowerResult == ESP_OK) {
    if (VERBOSE_LOGS) {
      Serial.println("Wi-Fi TX power set to ~8 dBm.");
    }
  } else {
    if (VERBOSE_LOGS) {
      Serial.printf("Failed to set Wi-Fi TX power (error %d).\n", static_cast<int>(txPowerResult));
    }
  }

  NetworkCandidate candidates[WIFI_NETWORK_COUNT] = {};
  const size_t candidateCount = collectConfiguredNetworks(candidates, WIFI_NETWORK_COUNT);
  if (candidateCount == 0) {
    return false;
  }
  sortCandidates(candidates, candidateCount);

  for (uint8_t attempt = 0; attempt < MAX_RETRIES; ++attempt) {
    const NetworkCandidate &primary = candidates[0];
    if (VERBOSE_LOGS) {
      Serial.printf("Attempt %u/%u: Connecting to %s...\n", attempt + 1, MAX_RETRIES,
                    primary.credential->ssid);
    }
    WiFi.begin(primary.credential->ssid, primary.credential->password);

    bool connected = false;
    for (uint8_t waitCycle = 0; waitCycle < STATUS_CHECK_ITERATIONS; ++waitCycle) {
      if (WiFi.status() == WL_CONNECTED) {
        connected = true;
        break;
      }
      if (VERBOSE_LOGS) {
        Serial.print('.');
      }
      delay(STATUS_CHECK_DELAY_MS);
    }
    if (VERBOSE_LOGS) {
      Serial.println();
    }

    if (connected) {
      if (VERBOSE_LOGS) {
        Serial.printf("Connected to %s\n", primary.credential->ssid);
      }
      if (checkInternet()) {
        return true;
      }
      if (VERBOSE_LOGS) {
        Serial.println("No internet access. Disconnecting...");
      }
      WiFi.disconnect(true);
      delay(1000);
    } else {
      if (VERBOSE_LOGS) {
        Serial.printf("Failed to connect to %s\n", primary.credential->ssid);
      }
      WiFi.disconnect(true);
      delay(500);
    }
  }

  if (VERBOSE_LOGS) {
    Serial.println("All connection attempts failed.");
  }
  return false;
}
