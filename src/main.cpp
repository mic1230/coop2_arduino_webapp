#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <ArduinoJson.h>
#include <esp_wifi.h>
#include <esp32-hal-adc.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <FS.h>
#include <LittleFS.h>
#include <time.h>
#include <vector>
#include <cstring>
#include <algorithm>

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
constexpr uint32_t WIFI_CONNECT_TIMEOUT_MS = 15000;
constexpr uint32_t WIFI_RETRY_DELAY_MS = 5000;
constexpr const char *WIFI_CREDENTIAL_PATH = "/wifi_config.json";
constexpr bool RETAIN_WIFI_CREDENTIALS_AFTER_REBOOT = false;  // Set false to force a clean config boot.
constexpr const char *WIFI_CONFIG_AP_SSID = "CoopDoorSetup";
constexpr uint32_t CONFIG_PORTAL_ANNOUNCE_INTERVAL_MS = 15000;
const IPAddress CONFIG_PORTAL_IP(192, 168, 4, 1);
const IPAddress CONFIG_PORTAL_NETMASK(255, 255, 255, 0);
constexpr uint16_t CAPTIVE_PORTAL_DNS_PORT = 53;

struct StoredCredential {
  String ssid;
  String password;
};

bool checkInternet();
size_t collectConfiguredNetworks(NetworkCandidate *candidates, size_t maxCandidates);
void sortCandidates(NetworkCandidate *candidates, size_t count);
bool connectToWifi();
bool attemptWifiConnection(const char *ssid, const char *password);
bool loadStoredCredential(StoredCredential &cred);
bool saveStoredCredential(const String &ssid, const String &password);
bool eraseStoredCredential();
void configureConfigRoutes();
void handleConfigRoot();
void handleConfigSubmit();
void startConfigPortal();
void announceConfigPortalStatus(bool force = false);
void handleWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info);
String escapeHtml(const String &value);
void startCaptiveDns(const IPAddress &apIp);
void stopCaptiveDns();
void serviceCaptiveDns();
bool handleCaptivePortalRedirect();
bool hostMatchesPortalIp(const String &hostValue);

//==============================================================================
// Door control (ported from MicroPython open_door / close_door)
//==============================================================================
constexpr uint8_t RELAY_OPEN_PIN = 4;   // Relay that drives the OPEN direction
constexpr uint8_t RELAY_CLOSE_PIN = 5;  // Relay that drives the CLOSE direction
constexpr uint32_t DOOR_TRAVEL_TIME_MS = 5000;
constexpr bool RELAY_ACTIVE_STATE = LOW;
constexpr bool RELAY_IDLE_STATE = HIGH;
constexpr bool TEST_MODE = true;  // When true, relays are not driven; logs only.
constexpr bool SERIAL_HEARTBEAT_ENABLED = false;
constexpr bool VERBOSE_LOGS = false;
constexpr uint32_t SERIAL_WAIT_TIMEOUT_MS = 2000;

//==============================================================================
// Sensor configuration (ported from MicroPython get_sensor_readings)
//==============================================================================
constexpr uint8_t DS18B20_PIN = 3;
constexpr uint8_t BATTERY_ADC_PIN = 1;  // Matches MicroPython's ADC Pin 1
constexpr float ADC_REFERENCE_VOLTS = 3.3f;
constexpr float VOLTAGE_DIVIDER_RATIO = 0.8333f;  // 10k / (10k + 2k)
constexpr uint16_t SENSOR_CONVERSION_DELAY_MS = 750;

//==============================================================================
// Door history tracking
//==============================================================================
constexpr size_t DOOR_HISTORY_CSV_BUFFER_LIMIT = 128;
constexpr size_t DOOR_HISTORY_DISPLAY_LIMIT = 30;
constexpr const char *DOOR_HISTORY_CSV_PATH = "/door_history.csv";
constexpr size_t DOOR_HISTORY_MAX_BYTES = 1024 * 1024;
constexpr uint32_t DOOR_HISTORY_HOURLY_SECONDS = 60 * 60;
constexpr const char *DOOR_HISTORY_CSV_HEADER =
    "timestamp,display_time,door_state,battery_temp_c,greenhouse_temp_c,battery_voltage,event\n";

struct DoorHistoryEntry;

OneWire onewireBus;
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
bool ensureFileSystem();
void loadDoorHistoryFromDisk();
void trimDoorHistoryCsv();
void appendDoorHistoryCsv(const DoorHistoryEntry &entry);
bool recordDoorHistory(const char *eventLabel);
void maybeRecordHourlyHistory();
void syncClock();
time_t currentTimestamp();
String formatHistoryTimestamp(time_t ts);
String formatDoorHistoryCsvLine(const DoorHistoryEntry &entry);
bool parseDoorHistoryCsvLine(const String &line, DoorHistoryEntry &entryOut);
void pushDoorHistoryEntry(const DoorHistoryEntry &entry);
bool serveEmbeddedAsset(WebServer &server, const String &requestPath);
void handleWebIndex();
void handleDoorHistoryEndpoint();
void handleDoorHistoryCsv();
bool waitForSerial(uint32_t timeoutMs = SERIAL_WAIT_TIMEOUT_MS);
void updateSerialAttachmentAnnounce();

WebServer apiServer(80);
bool apiServerEnabled = false;
bool configPortalActive = false;
uint32_t lastConfigPortalAnnounceMs = 0;
bool configPortalAnnouncementSent = false;
DNSServer configPortalDns;
bool configPortalDnsActive = false;

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

struct DoorHistoryEntry {
  time_t timestamp = 0;
  DoorState doorState = DoorState::Closed;
  bool hasBatteryTemp = false;
  float batteryTempC = 0.0f;
  bool hasGreenhouseTemp = false;
  float greenhouseTempC = 0.0f;
  bool hasBatteryVoltage = false;
  float batteryVoltage = 0.0f;
  String event;
};

std::vector<DoorHistoryEntry> doorHistoryEntries;
bool fileSystemReady = false;
time_t lastHourlyBucket = 0;
bool clockSynchronized = false;
static bool serialConsoleAttached = false;
static bool serialAnnouncementSent = false;

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
  recordDoorHistory("door_change");
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
  if (initialized || TEST_MODE) {
    return;
  }
  onewireBus.begin(DS18B20_PIN);
  temperatureBus.begin();
  temperatureBus.setWaitForConversion(false);
  if (VERBOSE_LOGS) {
    Serial.printf("DS18B20 bus initialized on pin %u.\n", DS18B20_PIN);
  }
  initialized = true;
}

void initBatteryAdc() {
  static bool configured = false;
  if (configured || TEST_MODE) {
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
  if (TEST_MODE) {
    return readings;
  }
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

bool ensureFileSystem() {
  if (fileSystemReady) {
    return true;
  }
  if (!LittleFS.begin(true)) {
    Serial.println("LittleFS mount failed.");
    return false;
  }
  fileSystemReady = true;
  return true;
}

bool loadStoredCredential(StoredCredential &cred) {
  if (!ensureFileSystem() || !LittleFS.exists(WIFI_CREDENTIAL_PATH)) {
    return false;
  }
  File file = LittleFS.open(WIFI_CREDENTIAL_PATH, "r");
  if (!file) {
    Serial.println("Failed to open Wi-Fi credential file.");
    return false;
  }
  StaticJsonDocument<256> doc;
  DeserializationError error = deserializeJson(doc, file);
  file.close();
  if (error) {
    Serial.printf("Wi-Fi credential parse failed: %s\n", error.c_str());
    return false;
  }
  const char *ssid = doc["ssid"];
  if (!ssid || std::strlen(ssid) == 0) {
    return false;
  }
  const char *password = doc["password"];
  cred.ssid = ssid;
  cred.password = password ? password : "";
  return true;
}

bool saveStoredCredential(const String &ssid, const String &password) {
  if (!ensureFileSystem()) {
    return false;
  }
  StaticJsonDocument<256> doc;
  doc["ssid"] = ssid;
  doc["password"] = password;
  File file = LittleFS.open(WIFI_CREDENTIAL_PATH, "w");
  if (!file) {
    Serial.println("Failed to open Wi-Fi credential file for writing.");
    return false;
  }
  const size_t written = serializeJson(doc, file);
  file.close();
  return written > 0;
}

bool eraseStoredCredential() {
  if (!ensureFileSystem()) {
    return false;
  }
  if (!LittleFS.exists(WIFI_CREDENTIAL_PATH)) {
    return true;
  }
  if (!LittleFS.remove(WIFI_CREDENTIAL_PATH)) {
    Serial.println("Failed to remove Wi-Fi credential file.");
    return false;
  }
  return true;
}

void pushDoorHistoryEntry(const DoorHistoryEntry &entry) {
  doorHistoryEntries.push_back(entry);
  if (doorHistoryEntries.size() > DOOR_HISTORY_CSV_BUFFER_LIMIT) {
    const size_t excess = doorHistoryEntries.size() - DOOR_HISTORY_CSV_BUFFER_LIMIT;
    doorHistoryEntries.erase(doorHistoryEntries.begin(), doorHistoryEntries.begin() + excess);
  }
}

String formatHistoryTimestamp(time_t ts) {
  if (ts <= 0) {
    return String(F("1970-01-01 00:00:00"));
  }
  struct tm timeinfo;
  gmtime_r(&ts, &timeinfo);
  char buffer[20];
  std::snprintf(buffer, sizeof(buffer), "%04d-%02d-%02d %02d:%02d:%02d",
                timeinfo.tm_year + 1900, timeinfo.tm_mon + 1, timeinfo.tm_mday, timeinfo.tm_hour,
                timeinfo.tm_min, timeinfo.tm_sec);
  return String(buffer);
}

String formatDoorHistoryCsvLine(const DoorHistoryEntry &entry) {
  String line;
  line.reserve(160);
  line += String(static_cast<unsigned long>(entry.timestamp));
  line += F(",");
  line += formatHistoryTimestamp(entry.timestamp);
  line += F(",");
  line += doorStateToString(entry.doorState);
  line += F(",");
  if (entry.hasBatteryTemp) {
    line += String(entry.batteryTempC, 2);
  }
  line += F(",");
  if (entry.hasGreenhouseTemp) {
    line += String(entry.greenhouseTempC, 2);
  }
  line += F(",");
  if (entry.hasBatteryVoltage) {
    line += String(entry.batteryVoltage, 2);
  }
  line += F(",");
  if (entry.event.length() > 0) {
    line += entry.event;
  } else {
    line += F("event");
  }
  line += '\n';
  return line;
}

bool parseDoorHistoryCsvLine(const String &line, DoorHistoryEntry &entryOut) {
  String trimmed = line;
  trimmed.trim();
  if (!trimmed.length()) {
    return false;
  }
  String parts[7];
  int partIndex = 0;
  int start = 0;
  while (partIndex < 6) {
    const int comma = trimmed.indexOf(',', start);
    if (comma < 0) {
      return false;
    }
    parts[partIndex++] = trimmed.substring(start, comma);
    start = comma + 1;
  }
  parts[partIndex] = trimmed.substring(start);
  DoorHistoryEntry entry;
  entry.timestamp = static_cast<time_t>(parts[0].toInt());
  entry.doorState = doorStateFromString(parts[2]);
  if (parts[3].length() > 0) {
    entry.hasBatteryTemp = true;
    entry.batteryTempC = parts[3].toFloat();
  }
  if (parts[4].length() > 0) {
    entry.hasGreenhouseTemp = true;
    entry.greenhouseTempC = parts[4].toFloat();
  }
  if (parts[5].length() > 0) {
    entry.hasBatteryVoltage = true;
    entry.batteryVoltage = parts[5].toFloat();
  }
  entry.event = parts[6];
  entryOut = entry;
  return true;
}

void loadDoorHistoryFromDisk() {
  if (!ensureFileSystem()) {
    return;
  }
  if (!LittleFS.exists(DOOR_HISTORY_CSV_PATH)) {
    return;
  }
  File file = LittleFS.open(DOOR_HISTORY_CSV_PATH, "r");
  if (!file) {
    Serial.println("Failed to open door history CSV.");
    return;
  }
  bool headerSkipped = false;
  while (file.available()) {
    String line = file.readStringUntil('\n');
    if (!headerSkipped) {
      headerSkipped = true;
      continue;
    }
    DoorHistoryEntry entry;
    if (parseDoorHistoryCsvLine(line, entry)) {
      pushDoorHistoryEntry(entry);
      if (entry.timestamp > 0 && entry.event == "hourly") {
        lastHourlyBucket = entry.timestamp - (entry.timestamp % DOOR_HISTORY_HOURLY_SECONDS);
      }
    }
  }
  file.close();
}

void trimDoorHistoryCsv() {
  if (!ensureFileSystem()) {
    return;
  }
  File file = LittleFS.open(DOOR_HISTORY_CSV_PATH, "r");
  if (!file) {
    return;
  }
  const size_t size = file.size();
  if (size <= DOOR_HISTORY_MAX_BYTES) {
    file.close();
    return;
  }
  std::vector<String> lines;
  while (file.available()) {
    lines.push_back(file.readStringUntil('\n'));
  }
  file.close();
  if (lines.empty()) {
    return;
  }
  const String header = lines.front();
  std::vector<String> data(lines.begin() + 1, lines.end());
  size_t total = header.length() + 1;
  std::vector<String> kept;
  kept.reserve(data.size());
  for (auto it = data.rbegin(); it != data.rend(); ++it) {
    total += it->length() + 1;
    if (total > DOOR_HISTORY_MAX_BYTES) {
      break;
    }
    kept.push_back(*it);
  }
  std::reverse(kept.begin(), kept.end());
  file = LittleFS.open(DOOR_HISTORY_CSV_PATH, "w");
  if (!file) {
    Serial.println("Failed to trim door history CSV.");
    return;
  }
  file.print(header);
  if (!header.endsWith("\n")) {
    file.print('\n');
  }
  for (const auto &line : kept) {
    file.print(line);
    if (!line.endsWith("\n")) {
      file.print('\n');
    }
  }
  file.close();
}

void appendDoorHistoryCsv(const DoorHistoryEntry &entry) {
  if (!ensureFileSystem()) {
    return;
  }
  const bool exists = LittleFS.exists(DOOR_HISTORY_CSV_PATH);
  File file = LittleFS.open(DOOR_HISTORY_CSV_PATH, exists ? "a" : "w");
  if (!file) {
    Serial.println("Unable to append door history CSV.");
    return;
  }
  if (!exists) {
    file.print(DOOR_HISTORY_CSV_HEADER);
  }
  file.print(formatDoorHistoryCsvLine(entry));
  file.close();
  trimDoorHistoryCsv();
}

time_t currentTimestamp() {
  const time_t nowTs = time(nullptr);
  if (nowTs > 1600000000) {
    return nowTs;
  }
  return 0;
}

bool recordDoorHistory(const char *eventLabel) {
  if (!ensureFileSystem()) {
    return false;
  }
  time_t nowTs = currentTimestamp();
  if (nowTs == 0 && WiFi.status() == WL_CONNECTED && !clockSynchronized) {
    syncClock();
    nowTs = currentTimestamp();
  }
  if (nowTs == 0) {
    return false;
  }
  const SensorReadings readings = getSensorReadings();
  DoorHistoryEntry entry;
  entry.timestamp = nowTs;
  entry.doorState = getDoorPosition();
  entry.hasBatteryTemp = readings.hasBatteryTemp;
  entry.batteryTempC = readings.batteryTempC;
  entry.hasGreenhouseTemp = readings.hasGreenhouseTemp;
  entry.greenhouseTempC = readings.greenhouseTempC;
  entry.hasBatteryVoltage = readings.hasBatteryVoltage;
  entry.batteryVoltage = readings.batteryVoltage;
  entry.event = eventLabel ? eventLabel : "event";
  pushDoorHistoryEntry(entry);
  appendDoorHistoryCsv(entry);
  return true;
}

void maybeRecordHourlyHistory() {
  const time_t nowTs = currentTimestamp();
  if (nowTs == 0) {
    return;
  }
  const time_t bucket = nowTs - (nowTs % DOOR_HISTORY_HOURLY_SECONDS);
  if (bucket == 0 || bucket == lastHourlyBucket) {
    return;
  }
  if (recordDoorHistory("hourly")) {
    lastHourlyBucket = bucket;
  }
}

bool waitForSerial(uint32_t timeoutMs) {
  const uint32_t start = millis();
  while (!Serial) {
    if (timeoutMs > 0 && millis() - start >= timeoutMs) {
      return false;
    }
    delay(10);
  }
  serialConsoleAttached = true;
  return true;
}

void updateSerialAttachmentAnnounce() {
  if (!serialConsoleAttached && Serial) {
    serialConsoleAttached = true;
  }
  if (serialConsoleAttached && !serialAnnouncementSent) {
    Serial.println(F("Serial console connected."));
    serialAnnouncementSent = true;
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
  String json =
      F("{\"service\":\"coop-door\",\"endpoints\":[\"/api/status\",\"/api/door\",\"/api/door/open\","
        "\"/api/door/close\",\"/api/sensors\",\"/api/history\",\"/history.csv\"]}");
  sendJsonResponse(200, json);
}

void handleDoorStatus() {
  sendJsonResponse(200, doorStatusToJson(getDoorPosition()));
}

void handleSensorsEndpoint() {
  const SensorReadings readings = getSensorReadings();
  sendJsonResponse(200, sensorReadingsToJson(readings));
}

void handleDoorHistoryEndpoint() {
  const size_t total = doorHistoryEntries.size();
  const size_t limit = total > DOOR_HISTORY_DISPLAY_LIMIT ? DOOR_HISTORY_DISPLAY_LIMIT : total;
  if (limit == 0) {
    sendJsonResponse(200, F("[]"));
    return;
  }
  String json;
  json.reserve(limit * 96 + 2);
  json += '[';
  for (size_t idx = 0; idx < limit; ++idx) {
    const DoorHistoryEntry &entry = doorHistoryEntries[total - 1 - idx];
    if (idx > 0) {
      json += ',';
    }
    json += F("{\"timestamp\":");
    json += String(static_cast<unsigned long>(entry.timestamp));
    json += F(",\"doorState\":\"");
    json += doorStateToString(entry.doorState);
    json += F("\",\"batteryTempC\":");
    json += entry.hasBatteryTemp ? String(entry.batteryTempC, 2) : F("null");
    json += F(",\"greenhouseTempC\":");
    json += entry.hasGreenhouseTemp ? String(entry.greenhouseTempC, 2) : F("null");
    json += F(",\"batteryVoltage\":");
    json += entry.hasBatteryVoltage ? String(entry.batteryVoltage, 2) : F("null");
    json += F(",\"event\":\"");
    json += escapeJson(entry.event);
    json += F("\"}");
  }
  json += ']';
  sendJsonResponse(200, json);
}

void handleDoorHistoryCsv() {
  if (!ensureFileSystem()) {
    apiServer.send(500, F("text/plain"), F("Storage unavailable."));
    return;
  }
  if (!LittleFS.exists(DOOR_HISTORY_CSV_PATH)) {
    apiServer.send(200, F("text/csv"), DOOR_HISTORY_CSV_HEADER);
    return;
  }
  File file = LittleFS.open(DOOR_HISTORY_CSV_PATH, "r");
  if (!file) {
    apiServer.send(500, F("text/plain"), F("Unable to read history.csv"));
    return;
  }
  apiServer.streamFile(file, F("text/csv"));
  file.close();
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

String escapeHtml(const String &value) {
  String escaped;
  escaped.reserve(value.length());
  for (size_t idx = 0; idx < static_cast<size_t>(value.length()); ++idx) {
    const char ch = value.charAt(idx);
    switch (ch) {
      case '&':
        escaped += F("&amp;");
        break;
      case '<':
        escaped += F("&lt;");
        break;
      case '>':
        escaped += F("&gt;");
        break;
      case '"':
        escaped += F("&quot;");
        break;
      case '\'':
        escaped += F("&#39;");
        break;
      default:
        escaped += ch;
        break;
    }
  }
  return escaped;
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
  if (configPortalActive) {
    handleConfigRoot();
    return;
  }
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

void handleConfigRoot() {
  if (handleCaptivePortalRedirect()) {
    return;
  }
  StoredCredential stored;
  String storedSsid;
  if (loadStoredCredential(stored)) {
    storedSsid = stored.ssid;
  }
  IPAddress portalIp = WiFi.softAPIP();
  if (portalIp == IPAddress(0, 0, 0, 0)) {
    portalIp = CONFIG_PORTAL_IP;
  }
  const String portalUrl = String(F("http://")) + portalIp.toString() + F("/");
  String page =
      F("<!doctype html><html><head><meta charset='utf-8'><meta name='viewport' "
        "content='width=device-width,initial-scale=1'><title>Coop Door Setup</title>"
        "<style>body{font-family:sans-serif;background:#f5f5f7;margin:0;padding:1.5rem;}"
        ".card{max-width:420px;margin:0 auto;background:#fff;border-radius:12px;padding:1.5rem;"
        "box-shadow:0 12px 25px rgba(15,23,42,0.15);}h1{margin-top:0;font-size:1.4rem;}"
        "label{display:block;margin-top:1rem;font-size:0.9rem;color:#334155;}"
        "input,select{width:100%;padding:0.65rem;border:1px solid #d0d5dd;border-radius:8px;font-size:1rem;}"
        "button{margin-top:1.25rem;width:100%;padding:0.9rem;border:none;border-radius:8px;"
        "background:#2563eb;color:#fff;font-size:1rem;font-weight:600;cursor:pointer;}"
        "button:hover{background:#1d4fd8;}p.note{margin-top:1rem;font-size:0.85rem;color:#475569;}"
        ".ssid-options{margin-top:0.5rem;max-height:180px;overflow-y:auto;border:1px solid #d0d5dd;"
        "border-radius:8px;padding:0.35rem;display:none;} .ssid-options button{margin:2px 0;padding:0.4rem;"
        "width:100%;border:1px solid #94a3b8;border-radius:6px;background:#f8fafc;color:#0f172a;font-weight:500;}"
        ".ssid-options button:hover{background:#dbeafe;}"
        "</style></head><body><div class='card'><h1>Configure Wi-Fi</h1>"
        "<form method='POST' action='/configure'>"
        "<label for='ssid'>Wi-Fi SSID</label>"
        "<input id='ssid' name='ssid' required value='");
  page += escapeHtml(storedSsid);
  page +=
      F("' autocomplete='off'>"
        "<div class='ssid-options' id='ssid-options'></div>"
        "<label for='password'>Password</label>"
        "<input id='password' name='password' type='password' placeholder='Leave empty for open network'>"
        "<button type='submit'>Save &amp; Reboot</button></form>"
        "<p class='note'>After saving, the controller restarts and tries connecting with the new network.</p>"
        "<p class='note'>Device hotspot address: <strong>");
  page += escapeHtml(portalUrl);
  page +=
      F("</strong></p>"
        "</div><script>(function(){var ssidInput=document.getElementById('ssid');"
        "var options=document.getElementById('ssid-options');"
        "function renderNetworks(list){if(!Array.isArray(list)||!list.length){options.style.display='none';return;}"
        "options.innerHTML='';list.forEach(function(net){var btn=document.createElement('button');"
        "btn.type='button';btn.textContent=net.ssid+(net.rssi?' ('+net.rssi+' dBm)':'');"
        "btn.addEventListener('click',function(){ssidInput.value=net.ssid;options.style.display='none';});"
        "options.appendChild(btn);});options.style.display='block';}"
        "async function fetchNetworks(){options.innerHTML='Scanning...';options.style.display='block';"
        "try{var response=await fetch('/scan');if(!response.ok)throw new Error('scan failed');"
        "var payload=await response.json();renderNetworks(payload);}catch(error){options.innerHTML='Scan failed';}}"
        "ssidInput.addEventListener('focus',function(){fetchNetworks();});})();</script>"
        "</body></html>");
  apiServer.send(200, F("text/html"), page);
}

void handleConfigSubmit() {
  if (!apiServer.hasArg("ssid")) {
    apiServer.send(400, F("text/plain"), F("Missing ssid"));
    return;
  }
  String ssid = apiServer.arg("ssid");
  String password = apiServer.arg("password");
  ssid.trim();
  password.trim();
  if (ssid.isEmpty()) {
    apiServer.send(400, F("text/plain"), F("SSID required"));
    return;
  }
  if (!saveStoredCredential(ssid, password)) {
    apiServer.send(500, F("text/plain"), F("Failed to store credentials"));
    return;
  }
  apiServer.send(200, F("text/html"),
                 F("<html><body><h2>Credentials saved.</h2><p>Rebooting...</p></body></html>"));
  delay(500);
  ESP.restart();
}

void handleScanWifi();

void announceConfigPortalStatus(bool force) {
  if (!configPortalActive) {
    return;
  }
  const uint32_t now = millis();
  if (!force && configPortalAnnouncementSent &&
      now - lastConfigPortalAnnounceMs < CONFIG_PORTAL_ANNOUNCE_INTERVAL_MS) {
    return;
  }
  IPAddress apIp = WiFi.softAPIP();
  if (apIp == IPAddress(0, 0, 0, 0)) {
    apIp = IPAddress(192, 168, 4, 1);
  }
  Serial.print("Config portal active. Connect to SSID '");
  Serial.print(WIFI_CONFIG_AP_SSID);
  Serial.print("' and browse to http://");
  Serial.println(apIp.toString());
  configPortalAnnouncementSent = true;
  lastConfigPortalAnnounceMs = now;
}

void handleWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  if (!configPortalActive) {
    return;
  }
  switch (event) {
    case ARDUINO_EVENT_WIFI_AP_STACONNECTED: {
      const wifi_event_ap_staconnected_t &connected = info.wifi_ap_staconnected;
      Serial.printf("Wi-Fi client %02X:%02X:%02X:%02X:%02X:%02X joined config AP (AID %u).\n",
                    connected.mac[0], connected.mac[1], connected.mac[2], connected.mac[3],
                    connected.mac[4], connected.mac[5], connected.aid);
      announceConfigPortalStatus(true);
      break;
    }
    case ARDUINO_EVENT_WIFI_AP_STADISCONNECTED: {
      const wifi_event_ap_stadisconnected_t &disconnected = info.wifi_ap_stadisconnected;
      Serial.printf(
          "Wi-Fi client %02X:%02X:%02X:%02X:%02X:%02X left config AP (AID %u).\n",
          disconnected.mac[0], disconnected.mac[1], disconnected.mac[2], disconnected.mac[3],
          disconnected.mac[4], disconnected.mac[5], disconnected.aid);
      break;
    }
    default:
      break;
  }
}

void startCaptiveDns(const IPAddress &apIp) {
  stopCaptiveDns();
  configPortalDnsActive = configPortalDns.start(CAPTIVE_PORTAL_DNS_PORT, "*", apIp);
  if (!configPortalDnsActive) {
    Serial.println("Failed to start captive portal DNS server.");
  }
}

void stopCaptiveDns() {
  if (!configPortalDnsActive) {
    return;
  }
  configPortalDns.stop();
  configPortalDnsActive = false;
}

void serviceCaptiveDns() {
  if (configPortalDnsActive) {
    configPortalDns.processNextRequest();
  }
}

bool hostMatchesPortalIp(const String &hostValue) {
  if (hostValue.isEmpty()) {
    return false;
  }
  String sanitized = hostValue;
  const int colonIndex = sanitized.indexOf(':');
  if (colonIndex > 0) {
    sanitized = sanitized.substring(0, colonIndex);
  }
  const IPAddress apIp = WiFi.softAPIP();
  const String apIpStr = apIp.toString();
  if (apIp == IPAddress(0, 0, 0, 0)) {
    return false;
  }
  return sanitized.equalsIgnoreCase(apIpStr);
}

bool handleCaptivePortalRedirect() {
  if (!configPortalActive) {
    return false;
  }
  const String hostHeader = apiServer.hostHeader();
  if (hostMatchesPortalIp(hostHeader)) {
    return false;
  }
  const IPAddress apIp = WiFi.softAPIP();
  if (apIp == IPAddress(0, 0, 0, 0)) {
    return false;
  }
  const String redirectTarget = String(F("http://")) + apIp.toString() + F("/");
  apiServer.sendHeader(F("Location"), redirectTarget, true);
  apiServer.sendHeader(F("Cache-Control"), F("no-cache, no-store, must-revalidate"));
  apiServer.sendHeader(F("Pragma"), F("no-cache"));
  apiServer.sendHeader(F("Expires"), F("0"));
  apiServer.send(302, F("text/plain"), F("Redirecting to configuration portal..."));
  return true;
}

void configureConfigRoutes() {
  apiServer.on("/", HTTP_GET, handleConfigRoot);
  apiServer.on("/configure", HTTP_POST, handleConfigSubmit);
  apiServer.on("/scan", HTTP_GET, handleScanWifi);
  apiServer.onNotFound(handleConfigRoot);
}

void handleScanWifi() {
  JsonDocument doc;
  JsonArray arr = doc.to<JsonArray>();
  const int16_t found = WiFi.scanNetworks(/*async=*/false, /*hidden=*/true);
  if (found > 0) {
    for (int16_t idx = 0; idx < found; ++idx) {
      JsonObject item = arr.add<JsonObject>();
      item["ssid"] = WiFi.SSID(idx);
      item["rssi"] = WiFi.RSSI(idx);
    }
  }
  String payload;
  serializeJson(doc, payload);
  apiServer.send(200, F("application/json"), payload);
}

void startConfigPortal() {
  configPortalActive = true;
  configPortalAnnouncementSent = false;
  lastConfigPortalAnnounceMs = 0;
  apiServer.stop();
  WiFi.disconnect(true, true);
  delay(100);
  WiFi.mode(WIFI_AP);
  if (!WiFi.softAP(WIFI_CONFIG_AP_SSID)) {
    Serial.println("Failed to start Wi-Fi config AP.");
  }
  WiFi.softAPConfig(CONFIG_PORTAL_IP, CONFIG_PORTAL_IP, CONFIG_PORTAL_NETMASK);
  startCaptiveDns(CONFIG_PORTAL_IP);
  announceConfigPortalStatus(true);
  configureConfigRoutes();
  apiServer.begin();
  apiServerEnabled = true;
}

void startApiServer() {
  apiServer.on("/", HTTP_GET, handleWebIndex);
  apiServer.on("/index.html", HTTP_GET, handleWebIndex);
  apiServer.on("/api", HTTP_GET, handleApiRoot);
  apiServer.on("/api/", HTTP_GET, handleApiRoot);
  apiServer.on("/api/status", HTTP_GET, handleStatusEndpoint);
  apiServer.on("/api/sensors", HTTP_GET, handleSensorsEndpoint);
  apiServer.on("/api/history", HTTP_GET, handleDoorHistoryEndpoint);
  apiServer.on("/api/door", HTTP_GET, handleDoorStatus);
  apiServer.on("/api/door/open", HTTP_OPTIONS, handleOptions);
  apiServer.on("/api/door/open", HTTP_POST, handleDoorOpen);
  apiServer.on("/api/door/close", HTTP_OPTIONS, handleOptions);
  apiServer.on("/api/door/close", HTTP_POST, handleDoorClose);
  apiServer.on("/history.csv", HTTP_GET, handleDoorHistoryCsv);
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
  const bool serialReady = waitForSerial(SERIAL_WAIT_TIMEOUT_MS);
  if (!serialReady) {
    Serial.println(F("Serial console not detected within timeout; continuing headless."));
  } else {
    updateSerialAttachmentAnnounce();
  }
  Serial.println("Booting coop door controller...");
  WiFi.onEvent(handleWifiEvent);

  initDoorHardware();
  ensureFileSystem();
  if (!RETAIN_WIFI_CREDENTIALS_AFTER_REBOOT) {
    if (eraseStoredCredential()) {
      Serial.println("Stored Wi-Fi credentials cleared (RETAIN_WIFI_CREDENTIALS_AFTER_REBOOT=false).");
    } else {
      Serial.println(
          "Requested Wi-Fi credential wipe failed; continuing with whatever is stored on disk.");
    }
  }
  loadDoorHistoryFromDisk();
  logSensorReadings();
  const DoorState bootState = getDoorPosition();
  Serial.printf("Boot-time door position: %s.\n", doorStateToString(bootState));
  logDoorStatusIfChanged(F("boot"), bootState);

  const bool wifiReady = connectToWifi();
  if (wifiReady) {
    Serial.print("Wi-Fi ready. IP address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Wi-Fi unavailable; starting configuration portal.");
    startConfigPortal();
    recordDoorHistory("boot");
    return;
  }

  syncClock();
  startApiServer();
  recordDoorHistory("boot");
}

void loop() {
  updateSerialAttachmentAnnounce();
  updateDoorMotion();
  maybeRecordHourlyHistory();
  announceConfigPortalStatus();
  // Heartbeat: emit a short line every second when a serial console is attached
  static uint32_t lastHeartbeatMs = 0;
  const uint32_t nowMs = millis();
  if (SERIAL_HEARTBEAT_ENABLED && serialConsoleAttached && nowMs - lastHeartbeatMs >= 1000) {
    Serial.println(F("[hb] alive"));
    lastHeartbeatMs = nowMs;
  }
  if (apiServerEnabled) {
    apiServer.handleClient();
  }
  serviceCaptiveDns();
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

bool attemptWifiConnection(const char *ssid, const char *password) {
  if (!ssid || std::strlen(ssid) == 0) {
    return false;
  }
  Serial.printf("Connecting to Wi-Fi SSID '%s'...\n", ssid);
  if (password && std::strlen(password) > 0) {
    WiFi.begin(ssid, password);
  } else {
    WiFi.begin(ssid);
  }
  bool connected = false;
  for (uint8_t waitCycle = 0; waitCycle < STATUS_CHECK_ITERATIONS; ++waitCycle) {
    if (WiFi.status() == WL_CONNECTED) {
      connected = true;
      break;
    }
    delay(STATUS_CHECK_DELAY_MS);
  }
  if (!connected) {
    Serial.println("Wi-Fi association timed out.");
    WiFi.disconnect(true);
    delay(500);
    return false;
  }
  if (!checkInternet()) {
    Serial.println("Connected but controller could not reach the internet.");
    WiFi.disconnect(true);
    delay(500);
    return false;
  }
  return true;
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

  bool connected = false;
  if (RETAIN_WIFI_CREDENTIALS_AFTER_REBOOT) {
    StoredCredential stored;
    if (loadStoredCredential(stored)) {
      Serial.printf("Attempting stored Wi-Fi credential for SSID '%s'.\n", stored.ssid.c_str());
      connected = attemptWifiConnection(stored.ssid.c_str(), stored.password.c_str());
      if (!connected) {
        Serial.println("Stored credential failed.");
      }
    }
  }

  if (!connected && TEST_MODE) {
    Serial.println("TEST MODE: Skipping default Wi-Fi credentials.");
  }

  NetworkCandidate candidates[WIFI_NETWORK_COUNT] = {};
  const size_t candidateCount = collectConfiguredNetworks(candidates, WIFI_NETWORK_COUNT);
  if (!connected && !TEST_MODE) {
    if (candidateCount == 0) {
      Serial.println("No known Wi-Fi networks found.");
    } else {
      sortCandidates(candidates, candidateCount);
      for (uint8_t attempt = 0; attempt < MAX_RETRIES && !connected; ++attempt) {
        for (size_t idx = 0; idx < candidateCount && !connected; ++idx) {
          const NetworkCandidate &candidate = candidates[idx];
          if (attemptWifiConnection(candidate.credential->ssid, candidate.credential->password)) {
            connected = true;
            break;
          }
          if (VERBOSE_LOGS) {
            Serial.printf("Failed to connect using configured network %s.\n",
                          candidate.credential->ssid);
          }
          WiFi.disconnect(true);
          delay(500);
        }
        if (!connected && attempt + 1 < MAX_RETRIES) {
          delay(WIFI_RETRY_DELAY_MS);
        }
      }
    }
  }

  if (!connected) {
    Serial.println("All Wi-Fi connection attempts failed.");
    return false;
  }

  const uint64_t mac = ESP.getEfuseMac();
  char hostname[32];
  std::snprintf(hostname, sizeof(hostname), "coop-door-%06llX",
                static_cast<unsigned long long>(mac & 0xFFFFFFULL));
  WiFi.setHostname(hostname);
  const String ipStr = WiFi.localIP().toString();
  const String macStr = WiFi.macAddress();
  Serial.printf("Connected to Wi-Fi. Hostname=%s, IP=%s, MAC=%s\n", hostname, ipStr.c_str(),
                macStr.c_str());
  return true;
}

void syncClock() {
  configTime(0, 0, "pool.ntp.org", "time.nist.gov", "time.google.com");
  struct tm timeinfo;
  for (int attempt = 0; attempt < 10; ++attempt) {
    if (getLocalTime(&timeinfo, 5000)) {
      clockSynchronized = true;
      Serial.println("Time synchronized via NTP.");
      return;
    }
    delay(500);
  }
  Serial.println("Time synchronization failed.");
}
