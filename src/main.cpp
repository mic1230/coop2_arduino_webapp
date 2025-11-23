#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <ArduinoJson.h>
#include <mqtt_client.h>
#include <esp_wifi.h>
#include <esp32-hal-adc.h>
#include <esp_sleep.h>
#include <Wire.h>
#include <FS.h>
#include <LittleFS.h>
#include <time.h>
#include <vector>
#include <cstring>
#include <algorithm>
#include <string>
#include <sstream>
#include <cmath>

#include "web_assets.h"

constexpr char BUILD_DATE[] = __DATE__;
constexpr char BUILD_TIME[] = __TIME__;
constexpr char BUILD_TIMESTAMP[] = __DATE__ " " __TIME__;

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
constexpr bool DEFAULT_RETAIN_WIFI_CREDENTIALS_AFTER_REBOOT = true;
bool retainWifiCredentialsAfterReboot = DEFAULT_RETAIN_WIFI_CREDENTIALS_AFTER_REBOOT;
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
void startConfigPortal();
void announceConfigPortalStatus(bool force = false);
void handleWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info);
void startCaptiveDns(const IPAddress &apIp);
void stopCaptiveDns();
void serviceCaptiveDns();
bool handleCaptivePortalRedirect();
bool hostMatchesPortalIp(const String &hostValue);
void handleScanWifi();
void handleWifiConfigStatus();
void handleWifiConfigUpdate();
bool initWifiPreferences();
void persistRetainWifiPreference(bool retain);

//==============================================================================
// Door control (ported from MicroPython open_door / close_door)
//==============================================================================
constexpr uint32_t DEFAULT_DOOR_TRAVEL_TIME_MS = 50000;
constexpr uint32_t MIN_DOOR_TRAVEL_TIME_MS = 1000;
constexpr uint32_t MAX_DOOR_TRAVEL_TIME_MS = 600000;
constexpr bool RELAY_ACTIVE_STATE = LOW;
constexpr bool RELAY_IDLE_STATE = HIGH;
constexpr bool TEST_MODE = false;  // When true, relays are not driven; logs only.
constexpr bool SERIAL_HEARTBEAT_ENABLED = false;
constexpr bool VERBOSE_LOGS = false;
constexpr uint32_t SERIAL_WAIT_TIMEOUT_MS = 2000;

//==============================================================================
// Sensor configuration (ported from MicroPython get_sensor_readings)
//==============================================================================
constexpr uint8_t BATTERY_ADC_PIN = 1;  // Matches MicroPython's ADC Pin 1
constexpr uint8_t DEFAULT_AVAILABLE_GPIO_PINS[] = {2,  4,  5,  12, 13, 14, 15, 16, 17, 18,
                                                   19, 21, 22, 23, 25, 26, 27, 32, 33};
constexpr size_t DEFAULT_AVAILABLE_GPIO_PIN_COUNT =
    sizeof(DEFAULT_AVAILABLE_GPIO_PINS) / sizeof(DEFAULT_AVAILABLE_GPIO_PINS[0]);

struct DoorPinConfig {
  uint8_t openPin = 21;
  uint8_t closePin = 20;
  uint8_t sensorPinSda = 22;
  uint8_t sensorPinScl = 23;
  uint32_t travelTimeMs = DEFAULT_DOOR_TRAVEL_TIME_MS;
};

constexpr DoorPinConfig DEFAULT_DOOR_PIN_ASSIGNMENTS = {21, 20, 22, 23, DEFAULT_DOOR_TRAVEL_TIME_MS};

DoorPinConfig doorPinConfig = DEFAULT_DOOR_PIN_ASSIGNMENTS;
constexpr float ADC_REFERENCE_VOLTS = 3.3f;
constexpr float VOLTAGE_DIVIDER_RATIO = 0.8333f;  // 10k / (10k + 2k)
constexpr uint8_t SHT31_I2C_ADDRESS = 0x44;
constexpr uint16_t SHT31_MEASUREMENT_DELAY_MS = 20;
constexpr uint8_t INVALID_PIN = 0xFF;

//==============================================================================
// Door history tracking
//==============================================================================
constexpr size_t DOOR_HISTORY_CSV_BUFFER_LIMIT = 128;
constexpr size_t DOOR_HISTORY_DISPLAY_LIMIT = 30;
constexpr const char *DOOR_HISTORY_CSV_PATH = "/door_history.csv";
constexpr size_t DOOR_HISTORY_MAX_BYTES = 25 * 1024;
constexpr uint32_t DOOR_HISTORY_HOURLY_SECONDS = 60 * 60;
constexpr const char *DOOR_HISTORY_CSV_HEADER =
    "timestamp,display_time,door_state,greenhouse_temp_c,greenhouse_humidity_pct,battery_voltage,event\n";
constexpr const char *DOOR_HISTORY_CSV_TEMP_PATH = "/door_history.tmp";

//==============================================================================
// Solar automation + device metadata (ported from radon thermostat patterns)
//==============================================================================
constexpr const char *SOLAR_CONFIG_PATH = "/solar_scheduler.json";
constexpr bool SOLAR_AUTOMATION_DEFAULT_ENABLED = false;
constexpr float DEFAULT_LATITUDE = 41.505f;
constexpr float DEFAULT_LONGITUDE = -81.690f;
constexpr int DEFAULT_SUNRISE_OFFSET_MIN = -15;
constexpr int DEFAULT_SUNSET_OFFSET_MIN = 30;
constexpr float MIN_LATITUDE = -89.0f;
constexpr float MAX_LATITUDE = 89.0f;
constexpr float MIN_LONGITUDE = -180.0f;
constexpr float MAX_LONGITUDE = 180.0f;
constexpr float SOLAR_ZENITH = 90.833f;
constexpr double DEG_TO_RAD_D = 0.0174532925199432957692;
constexpr double RAD_TO_DEG_D = 57.295779513082320876798;
constexpr int MIN_SUN_OFFSET_MINUTES = -720;
constexpr int MAX_SUN_OFFSET_MINUTES = 720;
constexpr uint32_t MANUAL_OVERRIDE_DURATION_SECONDS = 30 * 60;
constexpr char PREF_KEY_SCHED_OPEN_DAY[] = "sched_open_day";
constexpr char PREF_KEY_SCHED_CLOSE_DAY[] = "sched_close_day";
constexpr char PREF_KEY_SCHED_OPEN_TS[] = "sched_open_ts";
constexpr char PREF_KEY_SCHED_CLOSE_TS[] = "sched_close_ts";
constexpr char PREF_KEY_OVERRIDE_UNTIL[] = "override_until";

struct SolarScheduleConfig {
  bool enabled = SOLAR_AUTOMATION_DEFAULT_ENABLED;
  float latitude = DEFAULT_LATITUDE;
  float longitude = DEFAULT_LONGITUDE;
  int sunriseOffsetMinutes = DEFAULT_SUNRISE_OFFSET_MIN;
  int sunsetOffsetMinutes = DEFAULT_SUNSET_OFFSET_MIN;
};

struct SolarScheduleRuntime {
  SolarScheduleConfig config;
  bool dirty = true;
  bool timesValid = false;
  uint16_t computedDay = 0;
  time_t sunriseUtc = 0;
  time_t sunsetUtc = 0;
  time_t sunriseActionUtc = 0;
  time_t sunsetActionUtc = 0;
};

struct TimezoneOption {
  const char *id;
  const char *label;
  int offsetMinutes;
};

constexpr TimezoneOption TIMEZONE_OPTIONS[] = {
    {"UTC-12", "UTC-12:00 Baker Island", -720},   {"UTC-11", "UTC-11:00 Niue", -660},
    {"UTC-10", "UTC-10:00 Hawaii-Aleutian", -600},{"UTC-9", "UTC-09:00 Alaska", -540},
    {"UTC-8", "UTC-08:00 Pacific", -480},         {"UTC-7", "UTC-07:00 Mountain", -420},
    {"UTC-6", "UTC-06:00 Central", -360},         {"UTC-5", "UTC-05:00 Eastern", -300},
    {"UTC-4", "UTC-04:00 Atlantic", -240},        {"UTC-3_30", "UTC-03:30 Newfoundland", -210},
    {"UTC-3", "UTC-03:00 Argentina/Brazil", -180},{"UTC-2", "UTC-02:00 South Georgia", -120},
    {"UTC-1", "UTC-01:00 Azores", -60},           {"UTC", "UTC", 0},
    {"UTC+1", "UTC+01:00 Central Europe", 60},    {"UTC+2", "UTC+02:00 Eastern Europe", 120},
    {"UTC+3", "UTC+03:00 Moscow", 180},           {"UTC+3_30", "UTC+03:30 Iran", 210},
    {"UTC+4", "UTC+04:00 Gulf", 240},             {"UTC+4_30", "UTC+04:30 Afghanistan", 270},
    {"UTC+5", "UTC+05:00 Pakistan", 300},         {"UTC+5_30", "UTC+05:30 India", 330},
    {"UTC+5_45", "UTC+05:45 Nepal", 345},         {"UTC+6", "UTC+06:00 Bangladesh", 360},
    {"UTC+6_30", "UTC+06:30 Myanmar", 390},       {"UTC+7", "UTC+07:00 Indochina", 420},
    {"UTC+8", "UTC+08:00 China/West Aus", 480},   {"UTC+9", "UTC+09:00 Japan/Korea", 540},
    {"UTC+9_30", "UTC+09:30 Central Australia", 570},
    {"UTC+10", "UTC+10:00 Eastern Australia", 600},
    {"UTC+10_30", "UTC+10:30 Lord Howe", 630},    {"UTC+11", "UTC+11:00 Magadan", 660},
    {"UTC+12", "UTC+12:00 Fiji", 720},            {"UTC+12_45", "UTC+12:45 Chatham Islands", 765},
    {"UTC+13", "UTC+13:00 Tonga", 780},           {"UTC+14", "UTC+14:00 Line Islands", 840}};
constexpr size_t TIMEZONE_OPTION_COUNT = sizeof(TIMEZONE_OPTIONS) / sizeof(TIMEZONE_OPTIONS[0]);
constexpr const char *DEFAULT_TIMEZONE_ID = "UTC";
constexpr char PREF_KEY_TIMEZONE_ID[] = "tz_id";
constexpr char PREF_KEY_TIMEZONE_RENDER_ID[] = "tz_render";

//==============================================================================
// Power saving configuration
//==============================================================================
constexpr bool POWER_SAVING_DEFAULT_ENABLED = false;
constexpr uint32_t POWER_SAVING_DEFAULT_SLEEP_SECONDS = 30;
constexpr uint32_t POWER_SAVING_MIN_SLEEP_SECONDS = 1;
constexpr uint32_t POWER_SAVING_MAX_SLEEP_SECONDS = 200;
constexpr uint32_t POWER_SAVING_MIN_AWAKE_MS = 30000;
constexpr uint32_t POWER_SAVING_USER_ACTIVITY_GRACE_MS = 30000;
constexpr char PREF_KEY_POWER_SAVING_ENABLED[] = "ps_enabled";
constexpr char PREF_KEY_POWER_SAVING_SLEEP[] = "ps_sleep_s";
constexpr bool MODEM_SLEEP_DEFAULT_ENABLED = false;
constexpr char PREF_KEY_MODEM_SLEEP_ENABLED[] = "modem_sleep";

//==============================================================================
// MQTT configuration
//==============================================================================
constexpr char PREF_KEY_MQTT_HOST[] = "mqtt_host";
constexpr char PREF_KEY_MQTT_PORT[] = "mqtt_port";
constexpr char PREF_KEY_MQTT_USER[] = "mqtt_user";
constexpr char PREF_KEY_MQTT_PASS[] = "mqtt_pass";
constexpr uint16_t MQTT_DEFAULT_PORT = 1883;

struct MqttConfig {
  String host;
  uint16_t port = MQTT_DEFAULT_PORT;
  String username;
  String password;
};

struct PowerSavingConfig {
  bool enabled = POWER_SAVING_DEFAULT_ENABLED;
  uint32_t sleepSeconds = POWER_SAVING_DEFAULT_SLEEP_SECONDS;
};

struct DoorHistoryEntry;

TwoWire greenhouseSensorWire = TwoWire(0);

struct SensorReadings {
  bool hasGreenhouseTemp = false;
  float greenhouseTempC = 0.0f;
  bool hasGreenhouseHumidity = false;
  float greenhouseHumidityPct = 0.0f;
  bool hasBatteryVoltage = false;
  float batteryVoltage = 0.0f;
};

void initTemperatureSensors();
void initBatteryAdc();
SensorReadings getSensorReadings();
void logSensorReadings();
void resetTemperatureSensors();
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
bool parseDoorHistoryCsvLine(const String &line, DoorHistoryEntry &entryOut, bool legacyFormat);
void pushDoorHistoryEntry(const DoorHistoryEntry &entry);
bool serveEmbeddedAsset(WebServer &server, const String &requestPath);
void handleWebIndex();
void handleDoorHistoryEndpoint();
void handleDoorHistoryCsv();
void handleTimezoneStatus();
void handleTimezoneUpdate();
void loadTimezonePreference();
bool persistTimezonePreference(const String &timezoneId);
const TimezoneOption *findTimezoneOption(const String &timezoneId);
void ensureHistoryDisplayTimesCurrent();
bool rewriteDoorHistoryCsvDisplayTimes();
void applyTimezoneOption(const TimezoneOption &option);
PowerSavingConfig sanitizePowerSavingConfig(const PowerSavingConfig &config);
void loadPowerSavingConfig();
bool persistPowerSavingConfig(const PowerSavingConfig &config);
String powerSavingStatusToJson();
void handlePowerSavingStatus();
void handlePowerSavingUpdate();
void updatePowerSaving();
void loadModemSleepPreference();
bool persistModemSleepPreference(bool enabled);
void applyModemSleepSetting();
String modemSleepStatusToJson();
void handleModemSleepStatus();
void handleModemSleepUpdate();
MqttConfig sanitizeMqttConfig(const MqttConfig &config);
void loadMqttConfig();
bool persistMqttConfig(const MqttConfig &config);
String mqttConfigToJson();
bool mqttConfigured();
bool publishMqttReading(const String &topic, const String &payload);
void handleMqttStatus();
void handleMqttUpdate();
void handleMqttPublish();
bool waitForSerial(uint32_t timeoutMs = SERIAL_WAIT_TIMEOUT_MS);
void updateSerialAttachmentAnnounce();
bool loadSolarScheduleConfig();
bool saveSolarScheduleConfig(const SolarScheduleConfig &config);
void loadSolarScheduleExecutionState();
void persistSolarExecutionState();
void markSolarScheduleDirty();
void resetSolarScheduleRuntime();
bool ensureSolarScheduleTimes(time_t nowUtc);
void updateSolarScheduler();
uint16_t localDayOfYear(time_t ts);
String chipDescriptor();
String solarSchedulerStatusToJson(bool includeDeviceMeta = false);
void handleSolarScheduleStatus();
void handleSolarScheduleUpdate();
void loadManualOverrideState();
void persistManualOverrideState();
void beginManualOverride();
bool manualOverrideActive(time_t nowUtc = 0);
void updateManualOverride(time_t nowUtc = 0);
String escapeJson(const String &value);
MqttConfig sanitizeMqttConfig(const MqttConfig &config);
void loadMqttConfig();
bool persistMqttConfig(const MqttConfig &config);
String mqttConfigToJson();
bool mqttConfigured();
bool publishMqttReading(const String &topic, const String &payload);
void handleMqttStatus();
void handleMqttUpdate();
void handleMqttPublish();

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

Preferences wifiPrefs;
constexpr char WIFI_PREF_NAMESPACE[] = "wifi";
constexpr char WIFI_PREF_KEY_RETAIN[] = "retain";

bool initWifiPreferences() {
  static bool initialized = false;
  if (initialized) {
    return true;
  }
  initialized = wifiPrefs.begin(WIFI_PREF_NAMESPACE, false);
  if (!initialized) {
    Serial.println("Failed to open Wi-Fi preferences; using default retain setting.");
    retainWifiCredentialsAfterReboot = DEFAULT_RETAIN_WIFI_CREDENTIALS_AFTER_REBOOT;
    return false;
  }
  retainWifiCredentialsAfterReboot =
      wifiPrefs.getBool(WIFI_PREF_KEY_RETAIN, DEFAULT_RETAIN_WIFI_CREDENTIALS_AFTER_REBOOT);
  return true;
}

void persistRetainWifiPreference(bool retain) {
  retainWifiCredentialsAfterReboot = retain;
  if (!initWifiPreferences()) {
    Serial.println("Unable to persist Wi-Fi retain preference (prefs unavailable).");
    return;
  }
  wifiPrefs.putBool(WIFI_PREF_KEY_RETAIN, retain);
}

PowerSavingConfig powerSavingConfig;
uint32_t bootTimestampMs = 0;
uint32_t lastClientActivityMs = 0;
bool modemSleepEnabled = MODEM_SLEEP_DEFAULT_ENABLED;
MqttConfig mqttConfig;

enum class DoorState : uint8_t { Closed, Opened };

enum class DoorMotion : uint8_t { Idle, Opening, Closing };

enum class DoorCommandResult : uint8_t { Accepted, AlreadyAtTarget, Busy };

struct DoorMotionController {
  DoorMotion motion = DoorMotion::Idle;
  DoorState targetState = DoorState::Closed;
  uint32_t motionStartMs = 0;
};

DoorMotionController doorMotion;
uint8_t configuredRelayOpenPin = 0;
uint8_t configuredRelayClosePin = 0;
bool temperatureSensorsInitialized = false;
uint8_t configuredSensorSdaPin = INVALID_PIN;
uint8_t configuredSensorSclPin = INVALID_PIN;

struct DoorHistoryEntry {
  time_t timestamp = 0;
  DoorState doorState = DoorState::Closed;
  bool hasGreenhouseTemp = false;
  float greenhouseTempC = 0.0f;
  bool hasGreenhouseHumidity = false;
  float greenhouseHumidityPct = 0.0f;
  bool hasBatteryVoltage = false;
  float batteryVoltage = 0.0f;
  String event;
};

std::vector<DoorHistoryEntry> doorHistoryEntries;
SolarScheduleRuntime solarSchedule;
struct ManualOverrideState {
  bool active = false;
  time_t expiresUtc = 0;
};

ManualOverrideState manualOverride;
uint16_t lastSunriseCommandDay = 0;
uint16_t lastSunsetCommandDay = 0;
time_t lastSunriseCommandTs = 0;
time_t lastSunsetCommandTs = 0;
bool fileSystemReady = false;
time_t lastHourlyBucket = 0;
bool clockSynchronized = false;
String activeTimezoneId = DEFAULT_TIMEZONE_ID;
int activeTimezoneOffsetMinutes = 0;
static bool serialConsoleAttached = false;
static bool serialAnnouncementSent = false;

const char *doorStateToString(DoorState state) {
  return state == DoorState::Opened ? "opened" : "closed";
}

DoorState doorStateFromString(const String &value) {
  return value == "opened" ? DoorState::Opened : DoorState::Closed;
}

void initDoorHardware(bool force = false) {
  if (TEST_MODE) {
    Serial.println("TEST MODE: Door relays not initialized; hardware outputs disabled.");
    return;
  }

  const uint8_t openPin = doorPinConfig.openPin;
  const uint8_t closePin = doorPinConfig.closePin;
  if (!force && configuredRelayOpenPin == openPin && configuredRelayClosePin == closePin) {
    return;
  }

  auto configurePin = [](uint8_t pin) {
    pinMode(pin, OUTPUT);
    digitalWrite(pin, RELAY_IDLE_STATE);
  };

  configurePin(openPin);
  configurePin(closePin);
  configuredRelayOpenPin = openPin;
  configuredRelayClosePin = closePin;
  Serial.printf("Door relays initialized on pins open=%u close=%u (active-low).\n",
                static_cast<unsigned>(openPin), static_cast<unsigned>(closePin));
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
  return motion == DoorMotion::Opening ? doorPinConfig.openPin : doorPinConfig.closePin;
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
  setRelayState(doorPinConfig.openPin, false);
  setRelayState(doorPinConfig.closePin, false);
}


String chipDescriptor() {
  std::ostringstream oss;
  oss << ESP.getChipModel();
  const int revision = ESP.getChipRevision();
  if (revision >= 0) {
    oss << " rev " << revision;
  }
  oss << " (" << ESP.getChipCores() << " cores)";
#ifdef ARDUINO_VARIANT
  oss << " / " << ARDUINO_VARIANT;
#endif
const std::string text = oss.str();
  return String(text.c_str());
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
  if (elapsed >= doorPinConfig.travelTimeMs) {
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
void resetTemperatureSensors() {
  temperatureSensorsInitialized = false;
  configuredSensorSdaPin = INVALID_PIN;
  configuredSensorSclPin = INVALID_PIN;
}

void initTemperatureSensors() {
  if (TEST_MODE) {
    return;
  }
  const uint8_t sensorSda = doorPinConfig.sensorPinSda;
  const uint8_t sensorScl = doorPinConfig.sensorPinScl;
  if (temperatureSensorsInitialized && configuredSensorSdaPin == sensorSda &&
      configuredSensorSclPin == sensorScl) {
    return;
  }
  greenhouseSensorWire.begin(sensorSda, sensorScl);
  configuredSensorSdaPin = sensorSda;
  configuredSensorSclPin = sensorScl;
  temperatureSensorsInitialized = true;
  if (VERBOSE_LOGS) {
    Serial.printf("SHT31 sensor bus initialized on SDA=%u SCL=%u.\n",
                  static_cast<unsigned>(sensorSda), static_cast<unsigned>(sensorScl));
  }
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

uint8_t computeSht31Crc(const uint8_t *data) {
  uint8_t crc = 0xFF;
  for (uint8_t idx = 0; idx < 2; ++idx) {
    crc ^= data[idx];
    for (uint8_t bit = 0; bit < 8; ++bit) {
      if (crc & 0x80) {
        crc = static_cast<uint8_t>((crc << 1) ^ 0x31);
      } else {
        crc = static_cast<uint8_t>(crc << 1);
      }
    }
  }
  return crc;
}

bool readSht31Measurement(float &tempC, float &humidityPct) {
  tempC = NAN;
  humidityPct = NAN;
  greenhouseSensorWire.beginTransmission(SHT31_I2C_ADDRESS);
  greenhouseSensorWire.write(0x24);
  greenhouseSensorWire.write(0x00);
  if (greenhouseSensorWire.endTransmission() != 0) {
    return false;
  }
  delay(SHT31_MEASUREMENT_DELAY_MS);
  constexpr uint8_t EXPECTED_BYTES = 6;
  const uint8_t received = greenhouseSensorWire.requestFrom(SHT31_I2C_ADDRESS, EXPECTED_BYTES);
  if (received != EXPECTED_BYTES) {
    while (greenhouseSensorWire.available()) {
      greenhouseSensorWire.read();
    }
    return false;
  }
  uint8_t buffer[EXPECTED_BYTES];
  for (uint8_t idx = 0; idx < EXPECTED_BYTES; ++idx) {
    buffer[idx] = greenhouseSensorWire.read();
  }
  if (computeSht31Crc(buffer) != buffer[2] || computeSht31Crc(buffer + 3) != buffer[5]) {
    return false;
  }
  const uint16_t rawTemp = (static_cast<uint16_t>(buffer[0]) << 8) | buffer[1];
  const uint16_t rawHumidity = (static_cast<uint16_t>(buffer[3]) << 8) | buffer[4];
  tempC = -45.0f + 175.0f * (static_cast<float>(rawTemp) / 65535.0f);
  float humidity = 100.0f * (static_cast<float>(rawHumidity) / 65535.0f);
  if (humidity < 0.0f) {
    humidity = 0.0f;
  } else if (humidity > 100.0f) {
    humidity = 100.0f;
  }
  humidityPct = humidity;
  return true;
}

SensorReadings getSensorReadings() {
  SensorReadings readings;
  if (TEST_MODE) {
    return readings;
  }
  initTemperatureSensors();
  if (temperatureSensorsInitialized) {
    float greenhouseTemp = NAN;
    float humidity = NAN;
    if (readSht31Measurement(greenhouseTemp, humidity)) {
      if (!std::isnan(greenhouseTemp)) {
        readings.hasGreenhouseTemp = true;
        readings.greenhouseTempC = greenhouseTemp;
        if (VERBOSE_LOGS) {
          Serial.printf("Greenhouse temperature: %.2f C\n", greenhouseTemp);
        }
      }
      if (!std::isnan(humidity)) {
        readings.hasGreenhouseHumidity = true;
        readings.greenhouseHumidityPct = humidity;
        if (VERBOSE_LOGS) {
          Serial.printf("Greenhouse humidity: %.2f %%\n", humidity);
        }
      }
    } else if (VERBOSE_LOGS) {
      Serial.println("Failed to read greenhouse sensor data (I2C transaction failed).");
    }
  } else if (VERBOSE_LOGS) {
    Serial.println("SHT31 sensor not initialized; skipping greenhouse readings.");
  }

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
  if (!readings.hasGreenhouseTemp) {
    Serial.println("Greenhouse temperature reading unavailable.");
  }
  if (!readings.hasGreenhouseHumidity) {
    Serial.println("Greenhouse humidity reading unavailable.");
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
  ArduinoJson::JsonDocument doc;
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
  ArduinoJson::JsonDocument doc;
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

const TimezoneOption *findTimezoneOption(const String &timezoneId) {
  for (size_t idx = 0; idx < TIMEZONE_OPTION_COUNT; ++idx) {
    const TimezoneOption &option = TIMEZONE_OPTIONS[idx];
    if (timezoneId.equalsIgnoreCase(option.id)) {
      return &option;
    }
  }
  return nullptr;
}

void applyTimezoneOption(const TimezoneOption &option) {
  activeTimezoneId = option.id;
  activeTimezoneOffsetMinutes = option.offsetMinutes;
  markSolarScheduleDirty();
}

void loadTimezonePreference() {
  const TimezoneOption *selected = findTimezoneOption(String(DEFAULT_TIMEZONE_ID));
  if (selected == nullptr && TIMEZONE_OPTION_COUNT > 0) {
    selected = &TIMEZONE_OPTIONS[0];
  }
  if (initDoorPreferences()) {
    const String storedId =
        doorPrefs.getString(PREF_KEY_TIMEZONE_ID, selected ? selected->id : DEFAULT_TIMEZONE_ID);
    const TimezoneOption *stored = findTimezoneOption(storedId);
    if (stored != nullptr) {
      selected = stored;
    }
  }
  if (selected != nullptr) {
    applyTimezoneOption(*selected);
  }
}

bool persistTimezonePreference(const String &timezoneId) {
  if (!initDoorPreferences()) {
    Serial.println("Unable to persist timezone preference (prefs unavailable).");
    return false;
  }
  doorPrefs.putString(PREF_KEY_TIMEZONE_ID, timezoneId);
  return true;
}

float clampFloat(float value, float minValue, float maxValue) {
  if (value < minValue) {
    return minValue;
  }
  if (value > maxValue) {
    return maxValue;
  }
  return value;
}

void resetSolarScheduleRuntime() {
  solarSchedule.sunriseUtc = 0;
  solarSchedule.sunsetUtc = 0;
  solarSchedule.sunriseActionUtc = 0;
  solarSchedule.sunsetActionUtc = 0;
  solarSchedule.computedDay = 0;
  solarSchedule.timesValid = false;
}

void markSolarScheduleDirty() {
  solarSchedule.dirty = true;
  resetSolarScheduleRuntime();
}

bool loadSolarScheduleConfig() {
  SolarScheduleConfig defaults;
  solarSchedule.config = defaults;
  markSolarScheduleDirty();
  if (!ensureFileSystem() || !LittleFS.exists(SOLAR_CONFIG_PATH)) {
    Serial.println("Solar scheduler config missing; defaults applied.");
    return false;
  }
  File file = LittleFS.open(SOLAR_CONFIG_PATH, "r");
  if (!file) {
    Serial.println("Failed to open solar scheduler config.");
    return false;
  }
  ArduinoJson::JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, file);
  file.close();
  if (error) {
    Serial.printf("Solar config parse failed: %s\n", error.c_str());
    return false;
  }
  SolarScheduleConfig loaded;
  loaded.enabled = doc["enabled"] | SOLAR_AUTOMATION_DEFAULT_ENABLED;
  loaded.latitude = doc["latitude"] | DEFAULT_LATITUDE;
  loaded.longitude = doc["longitude"] | DEFAULT_LONGITUDE;
  loaded.sunriseOffsetMinutes = doc["sunriseOffsetMinutes"] | DEFAULT_SUNRISE_OFFSET_MIN;
  loaded.sunsetOffsetMinutes = doc["sunsetOffsetMinutes"] | DEFAULT_SUNSET_OFFSET_MIN;
  if (!std::isfinite(loaded.latitude)) {
    loaded.latitude = DEFAULT_LATITUDE;
  }
  if (!std::isfinite(loaded.longitude)) {
    loaded.longitude = DEFAULT_LONGITUDE;
  }
  loaded.latitude = clampFloat(loaded.latitude, MIN_LATITUDE, MAX_LATITUDE);
  loaded.longitude = clampFloat(loaded.longitude, MIN_LONGITUDE, MAX_LONGITUDE);
  if (loaded.sunriseOffsetMinutes < MIN_SUN_OFFSET_MINUTES) {
    loaded.sunriseOffsetMinutes = MIN_SUN_OFFSET_MINUTES;
  } else if (loaded.sunriseOffsetMinutes > MAX_SUN_OFFSET_MINUTES) {
    loaded.sunriseOffsetMinutes = MAX_SUN_OFFSET_MINUTES;
  }
  if (loaded.sunsetOffsetMinutes < MIN_SUN_OFFSET_MINUTES) {
    loaded.sunsetOffsetMinutes = MIN_SUN_OFFSET_MINUTES;
  } else if (loaded.sunsetOffsetMinutes > MAX_SUN_OFFSET_MINUTES) {
    loaded.sunsetOffsetMinutes = MAX_SUN_OFFSET_MINUTES;
  }
  solarSchedule.config = loaded;
  Serial.printf("Solar scheduler config loaded: enabled=%s lat=%.4f lon=%.4f sunriseOffset=%d sunsetOffset=%d\n",
                solarSchedule.config.enabled ? "true" : "false", solarSchedule.config.latitude,
                solarSchedule.config.longitude, solarSchedule.config.sunriseOffsetMinutes,
                solarSchedule.config.sunsetOffsetMinutes);
  return true;
}

bool saveSolarScheduleConfig(const SolarScheduleConfig &config) {
  if (!ensureFileSystem()) {
    return false;
  }
  ArduinoJson::JsonDocument doc;
  doc["enabled"] = config.enabled;
  doc["latitude"] = config.latitude;
  doc["longitude"] = config.longitude;
  doc["sunriseOffsetMinutes"] = config.sunriseOffsetMinutes;
  doc["sunsetOffsetMinutes"] = config.sunsetOffsetMinutes;
  File file = LittleFS.open(SOLAR_CONFIG_PATH, "w");
  if (!file) {
    Serial.println("Failed to open solar scheduler config for writing.");
    return false;
  }
  const size_t written = serializeJson(doc, file);
  file.close();
  if (written == 0) {
    Serial.println("Solar scheduler config write produced no data.");
    return false;
  }
  Serial.println("Solar scheduler config saved.");
  return true;
}

void loadSolarScheduleExecutionState() {
  if (!initDoorPreferences()) {
    return;
  }
  lastSunriseCommandDay = doorPrefs.getUShort(PREF_KEY_SCHED_OPEN_DAY, 0);
  lastSunsetCommandDay = doorPrefs.getUShort(PREF_KEY_SCHED_CLOSE_DAY, 0);
  lastSunriseCommandTs = static_cast<time_t>(doorPrefs.getULong(PREF_KEY_SCHED_OPEN_TS, 0));
  lastSunsetCommandTs = static_cast<time_t>(doorPrefs.getULong(PREF_KEY_SCHED_CLOSE_TS, 0));
}

void persistSolarExecutionState() {
  if (!initDoorPreferences()) {
    return;
  }
  doorPrefs.putUShort(PREF_KEY_SCHED_OPEN_DAY, lastSunriseCommandDay);
  doorPrefs.putUShort(PREF_KEY_SCHED_CLOSE_DAY, lastSunsetCommandDay);
  doorPrefs.putULong(PREF_KEY_SCHED_OPEN_TS, static_cast<uint32_t>(lastSunriseCommandTs));
  doorPrefs.putULong(PREF_KEY_SCHED_CLOSE_TS, static_cast<uint32_t>(lastSunsetCommandTs));
}

void loadManualOverrideState() {
  if (!initDoorPreferences()) {
    manualOverride.active = false;
    manualOverride.expiresUtc = 0;
    return;
  }
  manualOverride.expiresUtc = static_cast<time_t>(doorPrefs.getULong(PREF_KEY_OVERRIDE_UNTIL, 0));
  manualOverride.active = manualOverride.expiresUtc > 0;
}

void persistManualOverrideState() {
  if (!initDoorPreferences()) {
    return;
  }
  doorPrefs.putULong(PREF_KEY_OVERRIDE_UNTIL, static_cast<uint32_t>(manualOverride.expiresUtc));
}

bool manualOverrideActive(time_t nowTs) {
  if (!manualOverride.active) {
    return false;
  }
  if (manualOverride.expiresUtc == 0) {
    manualOverride.active = false;
    return false;
  }
  if (nowTs == 0) {
    nowTs = currentTimestamp();
  }
  if (nowTs == 0) {
    return manualOverride.active;
  }
  if (manualOverride.expiresUtc <= nowTs) {
    Serial.println("Manual override expired.");
    manualOverride.active = false;
    manualOverride.expiresUtc = 0;
    persistManualOverrideState();
    return false;
  }
  return true;
}

void updateManualOverride(time_t nowTs) {
  manualOverrideActive(nowTs);
}

void beginManualOverride() {
  if (!solarSchedule.config.enabled) {
    return;
  }
  time_t nowTs = currentTimestamp();
  if (nowTs == 0) {
    return;
  }
  manualOverride.active = true;
  manualOverride.expiresUtc = nowTs + MANUAL_OVERRIDE_DURATION_SECONDS;
  persistManualOverrideState();
  Serial.printf("Manual override enabled until %lld.\n", static_cast<long long>(manualOverride.expiresUtc));
}

uint16_t localDayOfYear(time_t ts) {
  if (ts <= 0) {
    return 0;
  }
  struct tm localTm;
  if (!localtime_r(&ts, &localTm)) {
    return 0;
  }
  return static_cast<uint16_t>(localTm.tm_yday + 1);
}

bool computeSolarEventUtc(bool sunrise, time_t referenceUtc, const SolarScheduleConfig &config,
                          time_t &eventUtcOut) {
  if (referenceUtc <= 0) {
    return false;
  }
  struct tm localTm;
  if (!localtime_r(&referenceUtc, &localTm)) {
    return false;
  }
  const double dayOfYear = static_cast<double>(localTm.tm_yday + 1);
  const double longitudeHour = static_cast<double>(config.longitude) / 15.0;
  const double t = sunrise ? (dayOfYear + ((6.0 - longitudeHour) / 24.0))
                           : (dayOfYear + ((18.0 - longitudeHour) / 24.0));
  double M = (0.9856 * t) - 3.289;
  double L = M + (1.916 * std::sin(DEG_TO_RAD_D * M)) + (0.020 * std::sin(2.0 * DEG_TO_RAD_D * M)) + 282.634;
  L = std::fmod(L, 360.0);
  if (L < 0) {
    L += 360.0;
  }
  double RA = RAD_TO_DEG_D * std::atan(0.91764 * std::tan(DEG_TO_RAD_D * L));
  RA = std::fmod(RA, 360.0);
  if (RA < 0) {
    RA += 360.0;
  }
  const double Lquadrant = std::floor(L / 90.0) * 90.0;
  const double RAquadrant = std::floor(RA / 90.0) * 90.0;
  RA = RA + (Lquadrant - RAquadrant);
  RA /= 15.0;
  const double sinDec = 0.39782 * std::sin(DEG_TO_RAD_D * L);
  const double cosDec = std::cos(std::asin(sinDec));
  const double cosH =
      (std::cos(DEG_TO_RAD_D * SOLAR_ZENITH) - (sinDec * std::sin(DEG_TO_RAD_D * config.latitude))) /
      (cosDec * std::cos(DEG_TO_RAD_D * config.latitude));
  if (cosH > 1.0 || cosH < -1.0) {
    return false;
  }
  double H = sunrise ? (360.0 - RAD_TO_DEG_D * std::acos(cosH)) : (RAD_TO_DEG_D * std::acos(cosH));
  H /= 15.0;
  const double T = H + RA - (0.06571 * t) - 6.622;
  double UT = T - longitudeHour;
  while (UT < 0.0) {
    UT += 24.0;
  }
  while (UT >= 24.0) {
    UT -= 24.0;
  }
  const double timezoneHours = static_cast<double>(activeTimezoneOffsetMinutes) / 60.0;
  double localHours = UT + timezoneHours;
  int dayAdjustment = 0;
  while (localHours < 0.0) {
    localHours += 24.0;
    --dayAdjustment;
  }
  while (localHours >= 24.0) {
    localHours -= 24.0;
    ++dayAdjustment;
  }
  struct tm midnightLocal = localTm;
  midnightLocal.tm_hour = 0;
  midnightLocal.tm_min = 0;
  midnightLocal.tm_sec = 0;
  time_t midnightEpoch = mktime(&midnightLocal);
  if (midnightEpoch == -1) {
    return false;
  }
  midnightEpoch += static_cast<time_t>(dayAdjustment) * 24 * 60 * 60;
  const double seconds = localHours * 3600.0;
  eventUtcOut = midnightEpoch + static_cast<time_t>(seconds);
  return true;
}

bool ensureSolarScheduleTimes(time_t nowUtc) {
  if (!solarSchedule.config.enabled) {
    return false;
  }
  const uint16_t day = localDayOfYear(nowUtc);
  if (day == 0) {
    return false;
  }
  if (solarSchedule.dirty || !solarSchedule.timesValid || solarSchedule.computedDay != day) {
    time_t sunriseUtc = 0;
    time_t sunsetUtc = 0;
    if (!computeSolarEventUtc(true, nowUtc, solarSchedule.config, sunriseUtc) ||
        !computeSolarEventUtc(false, nowUtc, solarSchedule.config, sunsetUtc)) {
      solarSchedule.timesValid = false;
      solarSchedule.dirty = false;
      return false;
    }
    const long sunriseOffsetSeconds =
        static_cast<long>(solarSchedule.config.sunriseOffsetMinutes) * 60L;
    const long sunsetOffsetSeconds =
        static_cast<long>(solarSchedule.config.sunsetOffsetMinutes) * 60L;
    solarSchedule.sunriseUtc = sunriseUtc;
    solarSchedule.sunsetUtc = sunsetUtc;
    solarSchedule.sunriseActionUtc = sunriseUtc + sunriseOffsetSeconds;
    solarSchedule.sunsetActionUtc = sunsetUtc + sunsetOffsetSeconds;
    solarSchedule.computedDay = day;
    solarSchedule.timesValid = true;
    solarSchedule.dirty = false;
    Serial.printf("Solar scheduler recalculated for day %u (sunrise action=%lld, sunset action=%lld)\n",
                  static_cast<unsigned>(day),
                  static_cast<long long>(solarSchedule.sunriseActionUtc),
                  static_cast<long long>(solarSchedule.sunsetActionUtc));
  }
  return solarSchedule.timesValid;
}

void updateSolarScheduler() {
  if (!solarSchedule.config.enabled) {
    return;
  }
  const time_t nowTs = currentTimestamp();
  if (nowTs == 0) {
    return;
  }
  if (manualOverrideActive(nowTs)) {
    return;
  }
  if (!ensureSolarScheduleTimes(nowTs)) {
    return;
  }
  if (doorMotion.motion != DoorMotion::Idle) {
    return;
  }
  const uint16_t today = localDayOfYear(nowTs);
  if (today == 0) {
    return;
  }
  auto triggerAction = [&](bool sunrise) {
    time_t targetTs = sunrise ? solarSchedule.sunriseActionUtc : solarSchedule.sunsetActionUtc;
    uint16_t *lastDay = sunrise ? &lastSunriseCommandDay : &lastSunsetCommandDay;
    time_t *lastTs = sunrise ? &lastSunriseCommandTs : &lastSunsetCommandTs;
    const char *label = sunrise ? "open" : "close";
    if (targetTs == 0 || nowTs < targetTs) {
      return;
    }
    if (*lastDay == today) {
      return;
    }
    DoorCommandResult result = sunrise ? openDoor() : closeDoor();
    if (result == DoorCommandResult::Accepted || result == DoorCommandResult::AlreadyAtTarget) {
      *lastDay = today;
      *lastTs = nowTs;
      persistSolarExecutionState();
      Serial.printf("Solar scheduler %s action result=%s\n", label, doorCommandResultToString(result));
      if (result == DoorCommandResult::AlreadyAtTarget) {
        recordDoorHistory(sunrise ? "scheduler_open_skip" : "scheduler_close_skip");
      }
    }
  };
  triggerAction(true);
  triggerAction(false);
}

String formatHistoryTimestamp(time_t ts) {
  if (ts <= 0) {
    return String(F("1970-01-01 00:00:00"));
  }
  const long offsetSeconds = static_cast<long>(activeTimezoneOffsetMinutes) * 60L;
  time_t adjusted = ts + offsetSeconds;
  struct tm timeinfo;
  gmtime_r(&adjusted, &timeinfo);
  char buffer[32];
  size_t written = std::strftime(buffer, sizeof(buffer), "%Y-%m-%d %H:%M:%S", &timeinfo);
  if (written == 0) {
    return String(F("1970-01-01 00:00:00"));
  }
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
  if (entry.hasGreenhouseTemp) {
    line += String(entry.greenhouseTempC, 2);
  }
  line += F(",");
  if (entry.hasGreenhouseHumidity) {
    line += String(entry.greenhouseHumidityPct, 2);
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

bool parseDoorHistoryCsvLine(const String &line, DoorHistoryEntry &entryOut, bool legacyFormat) {
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
  const int greenhouseTempIndex = legacyFormat ? 4 : 3;
  if (parts[greenhouseTempIndex].length() > 0) {
    entry.hasGreenhouseTemp = true;
    entry.greenhouseTempC = parts[greenhouseTempIndex].toFloat();
  }
  if (!legacyFormat && parts[4].length() > 0) {
    entry.hasGreenhouseHumidity = true;
    entry.greenhouseHumidityPct = parts[4].toFloat();
  }
  const int batteryVoltageIndex = legacyFormat ? 5 : 5;
  if (parts[batteryVoltageIndex].length() > 0) {
    entry.hasBatteryVoltage = true;
    entry.batteryVoltage = parts[batteryVoltageIndex].toFloat();
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
  bool legacyFormat = false;
  while (file.available()) {
    String line = file.readStringUntil('\n');
    if (!headerSkipped) {
      headerSkipped = true;
      legacyFormat = line.indexOf(F("battery_temp_c")) >= 0;
      continue;
    }
    DoorHistoryEntry entry;
    if (parseDoorHistoryCsvLine(line, entry, legacyFormat)) {
      pushDoorHistoryEntry(entry);
      if (entry.timestamp > 0 && entry.event == "hourly") {
        lastHourlyBucket = entry.timestamp - (entry.timestamp % DOOR_HISTORY_HOURLY_SECONDS);
      }
    }
  }
  file.close();
}

bool rewriteDoorHistoryCsvDisplayTimes() {
  if (!ensureFileSystem() || !LittleFS.exists(DOOR_HISTORY_CSV_PATH)) {
    return false;
  }
  File input = LittleFS.open(DOOR_HISTORY_CSV_PATH, "r");
  if (!input) {
    Serial.println("Unable to open history.csv for timezone rewrite.");
    return false;
  }
  File output = LittleFS.open(DOOR_HISTORY_CSV_TEMP_PATH, "w");
  if (!output) {
    Serial.println("Unable to open temporary history.csv for timezone rewrite.");
    input.close();
    return false;
  }
  output.print(DOOR_HISTORY_CSV_HEADER);
  bool headerSkipped = false;
  bool legacyFormat = false;
  while (input.available()) {
    String line = input.readStringUntil('\n');
    if (!headerSkipped) {
      headerSkipped = true;
      legacyFormat = line.indexOf(F("battery_temp_c")) >= 0;
      continue;
    }
    DoorHistoryEntry entry;
    if (!parseDoorHistoryCsvLine(line, entry, legacyFormat)) {
      continue;
    }
    output.print(formatDoorHistoryCsvLine(entry));
  }
  input.close();
  output.close();
  if (LittleFS.exists(DOOR_HISTORY_CSV_PATH) && !LittleFS.remove(DOOR_HISTORY_CSV_PATH)) {
    Serial.println("Failed to remove original history.csv during timezone rewrite.");
    LittleFS.remove(DOOR_HISTORY_CSV_TEMP_PATH);
    return false;
  }
  if (!LittleFS.rename(DOOR_HISTORY_CSV_TEMP_PATH, DOOR_HISTORY_CSV_PATH)) {
    Serial.println("Failed to rename timezone-updated history CSV.");
    LittleFS.remove(DOOR_HISTORY_CSV_TEMP_PATH);
    return false;
  }
  if (initDoorPreferences()) {
    doorPrefs.putString(PREF_KEY_TIMEZONE_RENDER_ID, activeTimezoneId);
  }
  return true;
}

void ensureHistoryDisplayTimesCurrent() {
  if (!initDoorPreferences()) {
    return;
  }
  const String renderedId =
      doorPrefs.getString(PREF_KEY_TIMEZONE_RENDER_ID, activeTimezoneId.c_str());
  if (renderedId == activeTimezoneId) {
    return;
  }
  if (rewriteDoorHistoryCsvDisplayTimes()) {
    Serial.println("Door history CSV display times updated for new timezone.");
  } else {
    Serial.println("Door history CSV timezone update failed; retaining previous timestamps.");
  }
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
  entry.hasGreenhouseTemp = readings.hasGreenhouseTemp;
  entry.greenhouseTempC = readings.greenhouseTempC;
  entry.hasGreenhouseHumidity = readings.hasGreenhouseHumidity;
  entry.greenhouseHumidityPct = readings.greenhouseHumidityPct;
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

//==============================================================================
// MQTT helpers
//==============================================================================
MqttConfig sanitizeMqttConfig(const MqttConfig &config) {
  MqttConfig sanitized = config;
  sanitized.host.trim();
  if (sanitized.port == 0) {
    sanitized.port = MQTT_DEFAULT_PORT;
  }
  return sanitized;
}

void loadMqttConfig() {
  MqttConfig loaded;
  if (initDoorPreferences()) {
    loaded.host = doorPrefs.getString(PREF_KEY_MQTT_HOST, "");
    loaded.port = doorPrefs.getUShort(PREF_KEY_MQTT_PORT, MQTT_DEFAULT_PORT);
    loaded.username = doorPrefs.getString(PREF_KEY_MQTT_USER, "");
    loaded.password = doorPrefs.getString(PREF_KEY_MQTT_PASS, "");
  }
  mqttConfig = sanitizeMqttConfig(loaded);
}

bool persistMqttConfig(const MqttConfig &config) {
  mqttConfig = sanitizeMqttConfig(config);
  if (!initDoorPreferences()) {
    Serial.println("Unable to persist MQTT config (prefs unavailable).");
    return false;
  }
  doorPrefs.putString(PREF_KEY_MQTT_HOST, mqttConfig.host);
  doorPrefs.putUShort(PREF_KEY_MQTT_PORT, mqttConfig.port);
  doorPrefs.putString(PREF_KEY_MQTT_USER, mqttConfig.username);
  doorPrefs.putString(PREF_KEY_MQTT_PASS, mqttConfig.password);
  return true;
}

String mqttConfigToJson() {
  String json;
  json.reserve(256);
  json += F("{\"host\":\"");
  json += escapeJson(mqttConfig.host);
  json += F("\",\"port\":");
  json += mqttConfig.port;
  json += F(",\"username\":\"");
  json += escapeJson(mqttConfig.username);
  json += F("\",\"hasPassword\":");
  json += mqttConfig.password.isEmpty() ? F("false") : F("true");
  json += F("}");
  return json;
}

bool mqttConfigured() {
  return mqttConfig.host.length() > 0 && mqttConfig.port > 0;
}

bool publishMqttReading(const String &topic, const String &payload) {
  if (!mqttConfigured() || WiFi.status() != WL_CONNECTED) {
    return false;
  }
  String uri = F("mqtt://");
  uri += mqttConfig.host;
  esp_mqtt_client_config_t config = {};
  config.broker.address.uri = uri.c_str();
  config.broker.address.port = mqttConfig.port;
  if (mqttConfig.username.length() > 0) {
    config.credentials.username = mqttConfig.username.c_str();
  }
  if (mqttConfig.password.length() > 0) {
    config.credentials.authentication.password = mqttConfig.password.c_str();
  }
  esp_mqtt_client_handle_t client = esp_mqtt_client_init(&config);
  if (client == nullptr) {
    return false;
  }
  if (esp_mqtt_client_start(client) != ESP_OK) {
    esp_mqtt_client_destroy(client);
    return false;
  }
  const int msgId = esp_mqtt_client_publish(client, topic.c_str(), payload.c_str(),
                                            payload.length(), 0, 0);
  esp_mqtt_client_stop(client);
  esp_mqtt_client_destroy(client);
  return msgId >= 0;
}

String mqttPublishPayload(const String &stream, const SensorReadings &readings, time_t ts) {
  String json;
  json.reserve(160);
  json += F("{\"stream\":\"");
  json += stream;
  json += F("\",\"timestamp\":");
  json += String(static_cast<unsigned long>(ts));
  json += F(",\"value\":");
  if (stream == "greenhouseTempC") {
    json += readings.hasGreenhouseTemp ? String(readings.greenhouseTempC, 2) : F("null");
  } else if (stream == "greenhouseHumidityPct") {
    json += readings.hasGreenhouseHumidity ? String(readings.greenhouseHumidityPct, 2) : F("null");
  } else if (stream == "batteryVoltage") {
    json += readings.hasBatteryVoltage ? String(readings.batteryVoltage, 2) : F("null");
  } else if (stream == "doorState") {
    json += '"';
    json += doorStateToString(getDoorPosition());
    json += '"';
  } else {
    json += F("null");
  }
  json += F("}");
  return json;
}

//==============================================================================
// Power saving (deep sleep) helpers
//==============================================================================
PowerSavingConfig sanitizePowerSavingConfig(const PowerSavingConfig &config) {
  PowerSavingConfig sanitized = config;
  if (sanitized.sleepSeconds < POWER_SAVING_MIN_SLEEP_SECONDS) {
    sanitized.sleepSeconds = POWER_SAVING_MIN_SLEEP_SECONDS;
  } else if (sanitized.sleepSeconds > POWER_SAVING_MAX_SLEEP_SECONDS) {
    sanitized.sleepSeconds = POWER_SAVING_MAX_SLEEP_SECONDS;
  }
  return sanitized;
}

void loadPowerSavingConfig() {
  PowerSavingConfig loaded;
  if (initDoorPreferences()) {
    loaded.enabled =
        doorPrefs.getBool(PREF_KEY_POWER_SAVING_ENABLED, POWER_SAVING_DEFAULT_ENABLED);
    loaded.sleepSeconds =
        doorPrefs.getUInt(PREF_KEY_POWER_SAVING_SLEEP, POWER_SAVING_DEFAULT_SLEEP_SECONDS);
  }
  powerSavingConfig = sanitizePowerSavingConfig(loaded);
}

bool persistPowerSavingConfig(const PowerSavingConfig &config) {
  if (!initDoorPreferences()) {
    Serial.println("Unable to persist power saving config (prefs unavailable).");
    return false;
  }
  powerSavingConfig = sanitizePowerSavingConfig(config);
  doorPrefs.putBool(PREF_KEY_POWER_SAVING_ENABLED, powerSavingConfig.enabled);
  doorPrefs.putUInt(PREF_KEY_POWER_SAVING_SLEEP, powerSavingConfig.sleepSeconds);
  return true;
}

String powerSavingStatusToJson() {
  powerSavingConfig = sanitizePowerSavingConfig(powerSavingConfig);
  const bool doorBusy = doorMotion.motion != DoorMotion::Idle;
  const bool portalActive = configPortalActive;
  const uint32_t nowMs = millis();
  const bool userActive =
      lastClientActivityMs > 0 && nowMs >= lastClientActivityMs &&
      nowMs - lastClientActivityMs < POWER_SAVING_USER_ACTIVITY_GRACE_MS;
  const bool blocked = doorBusy || portalActive || userActive;
  const uint32_t awakeMs = nowMs - bootTimestampMs;
  const uint32_t uptimeSeconds = nowMs / 1000;
  const uint32_t minAwakeSeconds = POWER_SAVING_MIN_AWAKE_MS / 1000;
  uint32_t remainingAwakeMs = 0;
  if (awakeMs < POWER_SAVING_MIN_AWAKE_MS) {
    remainingAwakeMs = POWER_SAVING_MIN_AWAKE_MS - awakeMs;
  }
  bool hasSleepEta = powerSavingConfig.enabled && !blocked;
  uint32_t secondsUntilSleep = 0;
  if (hasSleepEta && remainingAwakeMs > 0) {
    secondsUntilSleep = (remainingAwakeMs + 999) / 1000;
  }
  const bool readyForSleep = hasSleepEta && remainingAwakeMs == 0;

  String json;
  json.reserve(320);
  json += F("{\"enabled\":");
  json += powerSavingConfig.enabled ? F("true") : F("false");
  json += F(",\"sleepSeconds\":");
  json += String(powerSavingConfig.sleepSeconds);
  json += F(",\"minSleepSeconds\":");
  json += String(POWER_SAVING_MIN_SLEEP_SECONDS);
  json += F(",\"maxSleepSeconds\":");
  json += String(POWER_SAVING_MAX_SLEEP_SECONDS);
  json += F(",\"minAwakeSeconds\":");
  json += String(minAwakeSeconds);
  json += F(",\"uptimeSeconds\":");
  json += String(uptimeSeconds);
  json += F(",\"ready\":");
  json += readyForSleep ? F("true") : F("false");
  json += F(",\"secondsUntilSleep\":");
  if (hasSleepEta) {
    json += String(secondsUntilSleep);
  } else {
    json += F("null");
  }
  json += F(",\"blockers\":[");
  size_t count = 0;
  auto appendBlocker = [&](const char *label) {
    if (count > 0) {
      json += ',';
    }
    json += '"';
    json += label;
    json += '"';
    ++count;
  };
  if (doorBusy) {
    appendBlocker("door_motion");
  }
  if (portalActive) {
    appendBlocker("config_portal");
  }
  if (userActive) {
    appendBlocker("user_activity");
  }
  json += F("]}");
  return json;
}

void updatePowerSaving() {
  const PowerSavingConfig config = sanitizePowerSavingConfig(powerSavingConfig);
  if (!config.enabled) {
    return;
  }
  if (doorMotion.motion != DoorMotion::Idle) {
    return;
  }
  if (configPortalActive) {
    return;
  }
  const uint32_t nowMs = millis();
  if (lastClientActivityMs > 0 && nowMs >= lastClientActivityMs &&
      nowMs - lastClientActivityMs < POWER_SAVING_USER_ACTIVITY_GRACE_MS) {
    return;
  }
  const uint32_t awakeMs = nowMs - bootTimestampMs;
  if (awakeMs < POWER_SAVING_MIN_AWAKE_MS) {
    return;
  }
  const uint64_t sleepMicros = static_cast<uint64_t>(config.sleepSeconds) * 1000000ULL;
  Serial.printf("Entering deep sleep for %lus (power saving).\n",
                static_cast<unsigned long>(config.sleepSeconds));
  recordDoorHistory("power_saving_sleep");
  Serial.flush();
  esp_sleep_enable_timer_wakeup(sleepMicros);
  esp_deep_sleep_start();
}

void loadModemSleepPreference() {
  modemSleepEnabled = MODEM_SLEEP_DEFAULT_ENABLED;
  if (initDoorPreferences()) {
    modemSleepEnabled = doorPrefs.getBool(PREF_KEY_MODEM_SLEEP_ENABLED, MODEM_SLEEP_DEFAULT_ENABLED);
  }
}

bool persistModemSleepPreference(bool enabled) {
  modemSleepEnabled = enabled;
  if (!initDoorPreferences()) {
    Serial.println("Unable to persist modem sleep preference (prefs unavailable).");
    return false;
  }
  doorPrefs.putBool(PREF_KEY_MODEM_SLEEP_ENABLED, modemSleepEnabled);
  return true;
}

void applyModemSleepSetting() {
  const bool success = WiFi.setSleep(modemSleepEnabled);
  Serial.printf("Modem sleep %s (setSleep result=%s).\n", modemSleepEnabled ? "enabled" : "disabled",
                success ? "true" : "false");
}

String modemSleepStatusToJson() {
  String json;
  json.reserve(64);
  json += F("{\"enabled\":");
  json += modemSleepEnabled ? F("true") : F("false");
  json += F("}");
  return json;
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
  json.reserve(192);
  json += F("{\"greenhouseTempC\":");
  json += readings.hasGreenhouseTemp ? String(readings.greenhouseTempC, 2) : F("null");
  json += F(",\"greenhouseHumidityPct\":");
  json += readings.hasGreenhouseHumidity ? String(readings.greenhouseHumidityPct, 2) : F("null");
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
  const uint32_t travelTimeMs = doorPinConfig.travelTimeMs;
  if (busy) {
    const uint32_t elapsed = millis() - doorMotion.motionStartMs;
    if (elapsed >= travelTimeMs) {
      remainingMs = 0;
    } else {
      remainingMs = travelTimeMs - elapsed;
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
  json += String(travelTimeMs);
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

String solarSchedulerStatusToJson(bool includeDeviceMeta) {
  const time_t nowTs = currentTimestamp();
  if (nowTs > 0 && solarSchedule.config.enabled) {
    ensureSolarScheduleTimes(nowTs);
  }
  const bool enabled = solarSchedule.config.enabled;
  const bool timesValid = enabled && solarSchedule.timesValid;
  const uint16_t today = nowTs > 0 ? localDayOfYear(nowTs) : 0;
  const bool sunriseDone = today != 0 && today == lastSunriseCommandDay;
  const bool sunsetDone = today != 0 && today == lastSunsetCommandDay;
  const bool sunriseUpcoming = timesValid && !sunriseDone && solarSchedule.sunriseActionUtc >= nowTs;
  const bool sunsetUpcoming = timesValid && !sunsetDone && solarSchedule.sunsetActionUtc >= nowTs;
  const char *nextAction = nullptr;
  time_t nextActionTs = 0;
  if (sunriseUpcoming &&
      (!sunsetUpcoming || solarSchedule.sunriseActionUtc <= solarSchedule.sunsetActionUtc)) {
    nextAction = "open";
    nextActionTs = solarSchedule.sunriseActionUtc;
  } else if (sunsetUpcoming) {
    nextAction = "close";
    nextActionTs = solarSchedule.sunsetActionUtc;
  } else if (timesValid) {
    if (!sunriseDone) {
      nextAction = "open";
      nextActionTs = solarSchedule.sunriseActionUtc;
    } else if (!sunsetDone) {
      nextAction = "close";
      nextActionTs = solarSchedule.sunsetActionUtc;
    }
  }

  String json;
  json.reserve(includeDeviceMeta ? 512 : 320);
  json += F("{\"enabled\":");
  json += enabled ? F("true") : F("false");
  json += F(",\"latitude\":");
  json += String(solarSchedule.config.latitude, 6);
  json += F(",\"longitude\":");
  json += String(solarSchedule.config.longitude, 6);
  json += F(",\"sunriseOffsetMinutes\":");
  json += String(solarSchedule.config.sunriseOffsetMinutes);
  json += F(",\"sunsetOffsetMinutes\":");
  json += String(solarSchedule.config.sunsetOffsetMinutes);
  json += F(",\"timesValid\":");
  json += timesValid ? F("true") : F("false");
  json += F(",\"computedDay\":");
  if (solarSchedule.computedDay > 0) {
    json += String(solarSchedule.computedDay);
  } else {
    json += F("null");
  }
  auto appendTs = [&](time_t value, bool allow) {
    if (allow && value > 0) {
      json += String(static_cast<unsigned long>(value));
    } else {
      json += F("null");
    }
  };
  json += F(",\"sunriseTime\":");
  appendTs(solarSchedule.sunriseUtc, timesValid);
  json += F(",\"sunsetTime\":");
  appendTs(solarSchedule.sunsetUtc, timesValid);
  json += F(",\"sunriseActionTime\":");
  appendTs(solarSchedule.sunriseActionUtc, timesValid);
  json += F(",\"sunsetActionTime\":");
  appendTs(solarSchedule.sunsetActionUtc, timesValid);
  json += F(",\"nextAction\":");
  if (nextAction) {
    json += '"';
    json += nextAction;
    json += '"';
  } else {
    json += F("null");
  }
  json += F(",\"nextActionTime\":");
  appendTs(nextActionTs, nextAction != nullptr);
  json += F(",\"lastOpenAction\":");
  appendTs(lastSunriseCommandTs, lastSunriseCommandTs > 0);
  json += F(",\"lastCloseAction\":");
  appendTs(lastSunsetCommandTs, lastSunsetCommandTs > 0);
  const bool overrideActive = manualOverrideActive(nowTs);
  long overrideRemainingSeconds = 0;
  if (overrideActive && manualOverride.expiresUtc > 0 && nowTs > 0) {
    overrideRemainingSeconds =
        static_cast<long>(manualOverride.expiresUtc - nowTs);
    if (overrideRemainingSeconds < 0) {
      overrideRemainingSeconds = 0;
    }
  }
  json += F(",\"override\":{");
  json += F("\"active\":");
  json += overrideActive ? F("true") : F("false");
  json += F(",\"remainingSeconds\":");
  json += String(overrideRemainingSeconds);
  json += F(",\"expiresAt\":");
  if (overrideActive && manualOverride.expiresUtc > 0) {
    json += String(static_cast<unsigned long>(manualOverride.expiresUtc));
  } else {
    json += F("null");
  }
  json += F("}");
  if (includeDeviceMeta) {
    json += F(",\"device\":\"");
    json += escapeJson(chipDescriptor());
    json += F("\"");
  }
  json += F("}");
  return json;
}

void sendCorsHeaders() {
  apiServer.sendHeader(F("Access-Control-Allow-Origin"), F("*"));
  apiServer.sendHeader(F("Access-Control-Allow-Methods"), F("GET,POST,OPTIONS"));
  apiServer.sendHeader(F("Access-Control-Allow-Headers"), F("Content-Type"));
}

void sendJsonResponse(int statusCode, const String &body) {
  lastClientActivityMs = millis();
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
        "\"/api/door/close\",\"/api/sensors\",\"/api/history\",\"/api/timezone\",\"/api/schedule\","
        "\"/api/power\",\"/api/modem\",\"/api/mqtt\",\"/api/mqtt/publish\",\"/history.csv\"]}");
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
    json += F("\",\"greenhouseTempC\":");
    json += entry.hasGreenhouseTemp ? String(entry.greenhouseTempC, 2) : F("null");
    json += F(",\"greenhouseHumidityPct\":");
    json += entry.hasGreenhouseHumidity ? String(entry.greenhouseHumidityPct, 2) : F("null");
    json += F(",\"batteryVoltage\":");
    json += entry.hasBatteryVoltage ? String(entry.batteryVoltage, 2) : F("null");
    json += F(",\"event\":\"");
    json += escapeJson(entry.event);
    json += F("\",\"displayTime\":\"");
    json += formatHistoryTimestamp(entry.timestamp);
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
  if (result == DoorCommandResult::Accepted) {
    beginManualOverride();
  }
  sendJsonResponse(200, doorCommandResponseToJson(F("open"), result));
}

void handleDoorClose() {
  const DoorCommandResult result = closeDoor();
  if (result == DoorCommandResult::Accepted) {
    beginManualOverride();
  }
  sendJsonResponse(200, doorCommandResponseToJson(F("close"), result));
}

void handleStatusEndpoint() {
  const DoorState state = getDoorPosition();
  const SensorReadings readings = getSensorReadings();
  String json;
  json.reserve(640);
  json += F("{\"door\":");
  json += doorStatusToJson(state);
  json += F(",\"sensors\":");
  json += sensorReadingsToJson(readings);
  json += F(",\"wifi\":");
  json += wifiStatusToJson();
  json += F(",\"modemSleep\":");
  json += modemSleepStatusToJson();
  json += F(",\"mqtt\":");
  json += mqttConfigToJson();
  json += F(",\"powerSaving\":");
  json += powerSavingStatusToJson();
  json += F(",\"scheduler\":");
  json += solarSchedulerStatusToJson(false);
  json += F("}");
  sendJsonResponse(200, json);
}

void handleNotFound() {
  if (configPortalActive && handleCaptivePortalRedirect()) {
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

void handleScanWifi() {
  ArduinoJson::JsonDocument doc;
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
  sendJsonResponse(200, payload);
}

void handleWifiConfigStatus() {
  initWifiPreferences();
  StoredCredential stored;
  const bool hasStored = loadStoredCredential(stored);
  ArduinoJson::JsonDocument doc;
  doc["retainCredentials"] = retainWifiCredentialsAfterReboot;
  doc["configPortalActive"] = configPortalActive;
  doc["configSsid"] = WIFI_CONFIG_AP_SSID;
  doc["hasStored"] = hasStored;
  doc["storedSsid"] = hasStored ? stored.ssid : "";
  if (configPortalActive) {
    IPAddress apIp = WiFi.softAPIP();
    if (apIp != IPAddress(0, 0, 0, 0)) {
      doc["apIp"] = apIp.toString();
    } else {
      doc["apIp"] = CONFIG_PORTAL_IP.toString();
    }
  }
  String payload;
  serializeJson(doc, payload);
  sendJsonResponse(200, payload);
}

void handleWifiConfigUpdate() {
  initWifiPreferences();
  if (!apiServer.hasArg("plain")) {
    sendJsonResponse(400, F("{\"error\":\"missing_body\"}"));
    return;
  }
  const String body = apiServer.arg("plain");
  if (body.isEmpty()) {
    sendJsonResponse(400, F("{\"error\":\"missing_body\"}"));
    return;
  }
  ArduinoJson::JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, body);
  if (error) {
    sendJsonResponse(400, F("{\"error\":\"invalid_json\"}"));
    return;
  }
  const bool hasRetainField = !doc["retainCredentials"].isNull();
  const bool hasSsidField = !doc["ssid"].isNull();
  if (!hasRetainField && !hasSsidField) {
    sendJsonResponse(400, F("{\"error\":\"no_changes\"}"));
    return;
  }
  if (hasRetainField) {
    const bool retainRequested = doc["retainCredentials"].as<bool>();
    persistRetainWifiPreference(retainRequested);
  }
  bool savedCredentials = false;
  if (hasSsidField) {
    const char *ssidValue = doc["ssid"] | "";
    const char *passwordValue = doc["password"] | "";
    String ssid = String(ssidValue);
    String password = String(passwordValue);
    ssid.trim();
    password.trim();
    if (ssid.isEmpty()) {
      sendJsonResponse(400, F("{\"error\":\"ssid_required\"}"));
      return;
    }
    if (!saveStoredCredential(ssid, password)) {
      sendJsonResponse(500, F("{\"error\":\"save_failed\"}"));
      return;
    }
    savedCredentials = true;
  }
  ArduinoJson::JsonDocument response;
  response["retainCredentials"] = retainWifiCredentialsAfterReboot;
  response["savedCredentials"] = savedCredentials;
  response["rebooting"] = savedCredentials;
  response["configPortalActive"] = configPortalActive;
  response["configSsid"] = WIFI_CONFIG_AP_SSID;
  if (configPortalActive) {
    const IPAddress apIp = WiFi.softAPIP();
    if (apIp != IPAddress(0, 0, 0, 0)) {
      response["apIp"] = apIp.toString();
    }
  }
  String payload;
  serializeJson(response, payload);
  sendJsonResponse(200, payload);
  if (savedCredentials) {
    delay(500);
    ESP.restart();
  }
}

void handleTimezoneStatus() {
  const TimezoneOption *active = findTimezoneOption(activeTimezoneId);
  String json;
  json.reserve(512);
  json += F("{\"timezoneId\":\"");
  json += activeTimezoneId;
  json += F("\",\"offsetMinutes\":");
  json += activeTimezoneOffsetMinutes;
  if (active != nullptr) {
    json += F(",\"label\":\"");
    json += escapeJson(active->label);
    json += F("\"");
  }
  json += F(",\"options\":[");
  for (size_t idx = 0; idx < TIMEZONE_OPTION_COUNT; ++idx) {
    if (idx > 0) {
      json += ',';
    }
    json += F("{\"id\":\"");
    json += TIMEZONE_OPTIONS[idx].id;
    json += F("\",\"label\":\"");
    json += escapeJson(String(TIMEZONE_OPTIONS[idx].label));
    json += F("\",\"offsetMinutes\":");
    json += TIMEZONE_OPTIONS[idx].offsetMinutes;
    json += F("}");
  }
  json += F("]}");
  sendJsonResponse(200, json);
}

void handleTimezoneUpdate() {
  if (!apiServer.hasArg("plain")) {
    sendJsonResponse(400, F("{\"error\":\"missing_body\"}"));
    return;
  }
  const String body = apiServer.arg("plain");
  if (body.isEmpty()) {
    sendJsonResponse(400, F("{\"error\":\"missing_body\"}"));
    return;
  }
  ArduinoJson::JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, body);
  if (error) {
    sendJsonResponse(400, F("{\"error\":\"invalid_json\"}"));
    return;
  }
  const char *timezoneId = doc["id"] | "";
  if (!timezoneId || std::strlen(timezoneId) == 0) {
    sendJsonResponse(400, F("{\"error\":\"timezone_required\"}"));
    return;
  }
  const TimezoneOption *option = findTimezoneOption(String(timezoneId));
  if (option == nullptr) {
    sendJsonResponse(400, F("{\"error\":\"invalid_timezone\"}"));
    return;
  }
  applyTimezoneOption(*option);
  persistTimezonePreference(option->id);
  ensureHistoryDisplayTimesCurrent();
  clockSynchronized = false;
  syncClock();
  String json;
  json.reserve(256);
  json += F("{\"timezoneId\":\"");
  json += activeTimezoneId;
  json += F("\",\"offsetMinutes\":");
  json += activeTimezoneOffsetMinutes;
  json += F(",\"label\":\"");
  json += escapeJson(option->label);
  json += F("\"}");
  sendJsonResponse(200, json);
}

void handleSolarScheduleStatus() {
  sendJsonResponse(200, solarSchedulerStatusToJson(true));
}

void handleSolarScheduleUpdate() {
  if (!apiServer.hasArg("plain")) {
    sendJsonResponse(400, F("{\"error\":\"missing_body\"}"));
    return;
  }
  const String body = apiServer.arg("plain");
  if (body.isEmpty()) {
    sendJsonResponse(400, F("{\"error\":\"missing_body\"}"));
    return;
  }
  ArduinoJson::JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, body);
  if (error) {
    sendJsonResponse(400, F("{\"error\":\"invalid_json\"}"));
    return;
  }
  SolarScheduleConfig next = solarSchedule.config;
  bool changed = false;
  if (!doc["enabled"].isNull()) {
    const bool requested = doc["enabled"].as<bool>();
    if (requested != next.enabled) {
      next.enabled = requested;
      changed = true;
    }
  }
  if (!doc["latitude"].isNull()) {
    float lat = doc["latitude"].as<float>();
    if (!std::isfinite(lat)) {
      sendJsonResponse(400, F("{\"error\":\"invalid_latitude\"}"));
      return;
    }
    lat = clampFloat(lat, MIN_LATITUDE, MAX_LATITUDE);
    if (std::fabs(lat - next.latitude) > 0.0001f) {
      next.latitude = lat;
      changed = true;
    }
  }
  if (!doc["longitude"].isNull()) {
    float lon = doc["longitude"].as<float>();
    if (!std::isfinite(lon)) {
      sendJsonResponse(400, F("{\"error\":\"invalid_longitude\"}"));
      return;
    }
    lon = clampFloat(lon, MIN_LONGITUDE, MAX_LONGITUDE);
    if (std::fabs(lon - next.longitude) > 0.0001f) {
      next.longitude = lon;
      changed = true;
    }
  }
  auto parseOffset = [&](const char *field, int &target) -> bool {
    if (doc[field].isNull()) {
      return true;
    }
    int value = doc[field].as<int>();
    if (value < MIN_SUN_OFFSET_MINUTES || value > MAX_SUN_OFFSET_MINUTES) {
      return false;
    }
    if (value != target) {
      target = value;
      changed = true;
    }
    return true;
  };
  if (!parseOffset("sunriseOffsetMinutes", next.sunriseOffsetMinutes)) {
    sendJsonResponse(400, F("{\"error\":\"invalid_sunrise_offset\"}"));
    return;
  }
  if (!parseOffset("sunsetOffsetMinutes", next.sunsetOffsetMinutes)) {
    sendJsonResponse(400, F("{\"error\":\"invalid_sunset_offset\"}"));
    return;
  }
  if (!changed) {
    sendJsonResponse(200, solarSchedulerStatusToJson(true));
    return;
  }
  if (!saveSolarScheduleConfig(next)) {
    sendJsonResponse(500, F("{\"error\":\"save_failed\"}"));
    return;
  }
  solarSchedule.config = next;
  markSolarScheduleDirty();
  sendJsonResponse(200, solarSchedulerStatusToJson(true));
}

void handleMqttStatus() {
  sendJsonResponse(200, mqttConfigToJson());
}

void handleMqttUpdate() {
  if (!apiServer.hasArg("plain")) {
    sendJsonResponse(400, F("{\"error\":\"missing_body\"}"));
    return;
  }
  const String body = apiServer.arg("plain");
  if (body.isEmpty()) {
    sendJsonResponse(400, F("{\"error\":\"missing_body\"}"));
    return;
  }
  ArduinoJson::JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, body);
  if (error) {
    sendJsonResponse(400, F("{\"error\":\"invalid_json\"}"));
    return;
  }
  MqttConfig next = mqttConfig;
  bool changed = false;
  if (!doc["host"].isNull()) {
    String host = String(doc["host"].as<const char *>());
    host.trim();
    if (host != next.host) {
      next.host = host;
      changed = true;
    }
  }
  if (!doc["port"].isNull()) {
    int portVal = doc["port"].as<int>();
    if (portVal <= 0 || portVal > 65535) {
      sendJsonResponse(400, F("{\"error\":\"invalid_port\"}"));
      return;
    }
    uint16_t port = static_cast<uint16_t>(portVal);
    if (port != next.port) {
      next.port = port;
      changed = true;
    }
  }
  if (!doc["username"].isNull()) {
    const String user = String(doc["username"].as<const char *>());
    if (user != next.username) {
      next.username = user;
      changed = true;
    }
  }
  if (!doc["password"].isNull()) {
    const String pass = String(doc["password"].as<const char *>());
    if (pass != next.password) {
      next.password = pass;
      changed = true;
    }
  }
  next = sanitizeMqttConfig(next);
  if (!changed) {
    sendJsonResponse(200, mqttConfigToJson());
    return;
  }
  if (!persistMqttConfig(next)) {
    sendJsonResponse(500, F("{\"error\":\"save_failed\"}"));
    return;
  }
  sendJsonResponse(200, mqttConfigToJson());
}

void handleMqttPublish() {
  if (!mqttConfigured()) {
    sendJsonResponse(400, F("{\"error\":\"not_configured\"}"));
    return;
  }
  if (WiFi.status() != WL_CONNECTED) {
    sendJsonResponse(400, F("{\"error\":\"wifi_unavailable\"}"));
    return;
  }
  if (!apiServer.hasArg("plain")) {
    sendJsonResponse(400, F("{\"error\":\"missing_body\"}"));
    return;
  }
  const String body = apiServer.arg("plain");
  if (body.isEmpty()) {
    sendJsonResponse(400, F("{\"error\":\"missing_body\"}"));
    return;
  }
  ArduinoJson::JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, body);
  if (error) {
    sendJsonResponse(400, F("{\"error\":\"invalid_json\"}"));
    return;
  }
  const String topic = String(doc["topic"] | "");
  const String stream = String(doc["stream"] | "");
  if (topic.isEmpty()) {
    sendJsonResponse(400, F("{\"error\":\"topic_required\"}"));
    return;
  }
  if (stream.isEmpty()) {
    sendJsonResponse(400, F("{\"error\":\"stream_required\"}"));
    return;
  }
  SensorReadings readings = getSensorReadings();
  const time_t ts = currentTimestamp();
  const String payload = mqttPublishPayload(stream, readings, ts);
  if (!publishMqttReading(topic, payload)) {
    sendJsonResponse(500, F("{\"error\":\"publish_failed\"}"));
    return;
  }
  sendJsonResponse(200, F("{\"status\":\"ok\"}"));
}

void handlePowerSavingStatus() {
  sendJsonResponse(200, powerSavingStatusToJson());
}

void handlePowerSavingUpdate() {
  if (!apiServer.hasArg("plain")) {
    sendJsonResponse(400, F("{\"error\":\"missing_body\"}"));
    return;
  }
  const String body = apiServer.arg("plain");
  if (body.isEmpty()) {
    sendJsonResponse(400, F("{\"error\":\"missing_body\"}"));
    return;
  }
  ArduinoJson::JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, body);
  if (error) {
    sendJsonResponse(400, F("{\"error\":\"invalid_json\"}"));
    return;
  }
  PowerSavingConfig next = powerSavingConfig;
  bool changed = false;
  if (!doc["enabled"].isNull()) {
    next.enabled = doc["enabled"].as<bool>();
    changed = true;
  }
  if (!doc["sleepSeconds"].isNull()) {
    const int requested = doc["sleepSeconds"].as<int>();
    if (requested < static_cast<int>(POWER_SAVING_MIN_SLEEP_SECONDS) ||
        requested > static_cast<int>(POWER_SAVING_MAX_SLEEP_SECONDS)) {
      sendJsonResponse(400, F("{\"error\":\"invalid_sleep_seconds\"}"));
      return;
    }
    const uint32_t clamped = static_cast<uint32_t>(requested);
    if (clamped != next.sleepSeconds) {
      next.sleepSeconds = clamped;
      changed = true;
    }
  }
  next = sanitizePowerSavingConfig(next);
  if (!changed) {
    sendJsonResponse(200, powerSavingStatusToJson());
    return;
  }
  if (!persistPowerSavingConfig(next)) {
    sendJsonResponse(500, F("{\"error\":\"save_failed\"}"));
    return;
  }
  sendJsonResponse(200, powerSavingStatusToJson());
}

void handleModemSleepStatus() {
  sendJsonResponse(200, modemSleepStatusToJson());
}

void handleModemSleepUpdate() {
  if (!apiServer.hasArg("plain")) {
    sendJsonResponse(400, F("{\"error\":\"missing_body\"}"));
    return;
  }
  const String body = apiServer.arg("plain");
  if (body.isEmpty()) {
    sendJsonResponse(400, F("{\"error\":\"missing_body\"}"));
    return;
  }
  ArduinoJson::JsonDocument doc;
  const DeserializationError error = deserializeJson(doc, body);
  if (error) {
    sendJsonResponse(400, F("{\"error\":\"invalid_json\"}"));
    return;
  }
  if (doc["enabled"].isNull()) {
    sendJsonResponse(400, F("{\"error\":\"enabled_required\"}"));
    return;
  }
  const bool requested = doc["enabled"].as<bool>();
  if (requested == modemSleepEnabled) {
    sendJsonResponse(200, modemSleepStatusToJson());
    return;
  }
  if (!persistModemSleepPreference(requested)) {
    sendJsonResponse(500, F("{\"error\":\"save_failed\"}"));
    return;
  }
  applyModemSleepSetting();
  sendJsonResponse(200, modemSleepStatusToJson());
}


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

void startConfigPortal() {
  if (configPortalActive) {
    return;
  }
  configPortalActive = true;
  configPortalAnnouncementSent = false;
  lastConfigPortalAnnounceMs = 0;
  WiFi.disconnect(true, true);
  delay(100);
  WiFi.mode(WIFI_AP);
  if (!WiFi.softAP(WIFI_CONFIG_AP_SSID)) {
    Serial.println("Failed to start Wi-Fi config AP.");
  }
  applyModemSleepSetting();
  WiFi.softAPConfig(CONFIG_PORTAL_IP, CONFIG_PORTAL_IP, CONFIG_PORTAL_NETMASK);
  startCaptiveDns(CONFIG_PORTAL_IP);
  announceConfigPortalStatus(true);
}

void startApiServer() {
  if (apiServerEnabled) {
    return;
  }
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
  apiServer.on("/api/wifi/scan", HTTP_OPTIONS, handleOptions);
  apiServer.on("/api/wifi/scan", HTTP_GET, handleScanWifi);
  apiServer.on("/api/wifi/config", HTTP_OPTIONS, handleOptions);
  apiServer.on("/api/wifi/config", HTTP_GET, handleWifiConfigStatus);
  apiServer.on("/api/wifi/config", HTTP_POST, handleWifiConfigUpdate);
  apiServer.on("/api/timezone", HTTP_OPTIONS, handleOptions);
  apiServer.on("/api/timezone", HTTP_GET, handleTimezoneStatus);
  apiServer.on("/api/timezone", HTTP_POST, handleTimezoneUpdate);
  apiServer.on("/api/schedule", HTTP_OPTIONS, handleOptions);
  apiServer.on("/api/schedule", HTTP_GET, handleSolarScheduleStatus);
  apiServer.on("/api/schedule", HTTP_POST, handleSolarScheduleUpdate);
  apiServer.on("/api/power", HTTP_OPTIONS, handleOptions);
  apiServer.on("/api/power", HTTP_GET, handlePowerSavingStatus);
  apiServer.on("/api/power", HTTP_POST, handlePowerSavingUpdate);
  apiServer.on("/api/modem", HTTP_OPTIONS, handleOptions);
  apiServer.on("/api/modem", HTTP_GET, handleModemSleepStatus);
  apiServer.on("/api/modem", HTTP_POST, handleModemSleepUpdate);
  apiServer.on("/api/mqtt", HTTP_OPTIONS, handleOptions);
  apiServer.on("/api/mqtt", HTTP_GET, handleMqttStatus);
  apiServer.on("/api/mqtt", HTTP_POST, handleMqttUpdate);
  apiServer.on("/api/mqtt/publish", HTTP_OPTIONS, handleOptions);
  apiServer.on("/api/mqtt/publish", HTTP_POST, handleMqttPublish);
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
  bootTimestampMs = millis();
  const bool serialReady = waitForSerial(SERIAL_WAIT_TIMEOUT_MS);
  if (!serialReady) {
    Serial.println(F("Serial console not detected within timeout; continuing headless."));
  } else {
    updateSerialAttachmentAnnounce();
  }
  Serial.println("Booting coop door controller...");
  WiFi.onEvent(handleWifiEvent);

  ensureFileSystem();
  initDoorPreferences();
  loadPowerSavingConfig();
  loadModemSleepPreference();
  loadMqttConfig();
  initDoorHardware(true);
  loadSolarScheduleConfig();
  loadSolarScheduleExecutionState();
  loadManualOverrideState();
  loadTimezonePreference();
  initWifiPreferences();
  if (!retainWifiCredentialsAfterReboot) {
    if (eraseStoredCredential()) {
      Serial.println("Stored Wi-Fi credentials cleared (retain setting disabled).");
    } else {
      Serial.println("Requested Wi-Fi credential wipe failed; continuing with stored config.");
    }
  }
  loadDoorHistoryFromDisk();
  ensureHistoryDisplayTimesCurrent();
  logSensorReadings();
  const DoorState bootState = getDoorPosition();
  Serial.printf("Boot-time door position: %s.\n", doorStateToString(bootState));
  logDoorStatusIfChanged(F("boot"), bootState);

  const bool wifiReady = connectToWifi();
  if (wifiReady) {
    Serial.print("Wi-Fi ready. IP address: ");
    Serial.println(WiFi.localIP());
    syncClock();
    applyModemSleepSetting();
  } else {
    Serial.println("Wi-Fi unavailable; starting configuration portal.");
    startConfigPortal();
  }

  startApiServer();
  recordDoorHistory("boot");
}

void loop() {
  updateSerialAttachmentAnnounce();
  updateDoorMotion();
  updateManualOverride(0);
  updateSolarScheduler();
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
  updatePowerSaving();
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
        Serial.printf("%s (%ddBm)%s", candidates[idx].credential->ssid,
                      static_cast<int>(candidates[idx].rssi),
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
  if (retainWifiCredentialsAfterReboot) {
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
  const long offsetSeconds = static_cast<long>(activeTimezoneOffsetMinutes) * 60L;
  configTime(offsetSeconds, 0, "pool.ntp.org", "time.nist.gov", "time.google.com");
  struct tm timeinfo;
  for (int attempt = 0; attempt < 10; ++attempt) {
    if (getLocalTime(&timeinfo, 5000)) {
      clockSynchronized = true;
      Serial.println("Time synchronized via NTP.");
      markSolarScheduleDirty();
      return;
    }
    delay(500);
  }
  Serial.println("Time synchronization failed.");
}
