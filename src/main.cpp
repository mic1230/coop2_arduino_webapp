#include <Arduino.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClient.h>
#include <esp_wifi.h>
#include <esp32-hal-adc.h>
#include <OneWire.h>
#include <DallasTemperature.h>

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
constexpr uint32_t DOOR_TRAVEL_TIME_MS = 50000;
constexpr bool RELAY_ACTIVE_STATE = LOW;
constexpr bool RELAY_IDLE_STATE = HIGH;
constexpr bool TEST_MODE = true;  // When true, relays are not driven; logs only.

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

Preferences doorPrefs;
constexpr char PREF_NAMESPACE[] = "coopdoor";
constexpr char PREF_KEY_STATE[] = "state";

enum class DoorState : uint8_t { Closed, Opened };

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
  Serial.printf("Door state recalled as %s.\n", doorStateToString(state));
  return state;
}

void setDoorPosition(DoorState state) {
  if (!initDoorPreferences()) {
    Serial.println("Unable to persist door state (prefs unavailable).");
    return;
  }
  doorPrefs.putString(PREF_KEY_STATE, doorStateToString(state));
  Serial.printf("Door state stored as %s.\n", doorStateToString(state));
}

void pulseRelay(uint8_t pin) {
  if (TEST_MODE) {
    Serial.printf("TEST MODE: Simulating relay on pin %u for %lu ms.\n", pin, DOOR_TRAVEL_TIME_MS);
    delay(DOOR_TRAVEL_TIME_MS);
    Serial.printf("TEST MODE: Relay simulation for pin %u complete.\n", pin);
    return;
  }

  Serial.printf("Activating relay on pin %u for %lu ms.\n", pin, DOOR_TRAVEL_TIME_MS);
  digitalWrite(pin, RELAY_ACTIVE_STATE);
  delay(DOOR_TRAVEL_TIME_MS);
  digitalWrite(pin, RELAY_IDLE_STATE);
  Serial.printf("Relay on pin %u returned to idle.\n", pin);
}

bool openDoor() {
  const DoorState current = getDoorPosition();
  if (current == DoorState::Opened) {
    Serial.println("Door already opened - no action taken.");
    return false;
  }

  Serial.println("Opening door...");
  pulseRelay(RELAY_OPEN_PIN);
  setDoorPosition(DoorState::Opened);
  Serial.println("Door opened.");
  return true;
}

bool closeDoor() {
  const DoorState current = getDoorPosition();
  if (current == DoorState::Closed) {
    Serial.println("Door already closed - no action taken.");
    return false;
  }

  Serial.println("Closing door...");
  pulseRelay(RELAY_CLOSE_PIN);
  setDoorPosition(DoorState::Closed);
  Serial.println("Door closed.");
  return true;
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
  Serial.printf("DS18B20 bus initialized on pin %u.\n", DS18B20_PIN);
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
  Serial.printf("Battery ADC configured on pin %u.\n", BATTERY_ADC_PIN);
  configured = true;
}

bool readTemperature(const DeviceAddress address, const char *label, float &valueOut) {
  const float tempC = temperatureBus.getTempC(address);
  if (tempC == DEVICE_DISCONNECTED_C) {
    Serial.printf("Failed to read %s temperature (sensor disconnected?).\n", label);
    return false;
  }
  valueOut = tempC;
  Serial.printf("%s temperature: %.2f C\n", label, tempC);
  return true;
}

SensorReadings getSensorReadings() {
  SensorReadings readings;
  initTemperatureSensors();
  Serial.println("Requesting DS18B20 temperature readings...");
  temperatureBus.requestTemperatures();
  delay(SENSOR_CONVERSION_DELAY_MS);

  readings.hasBatteryTemp = readTemperature(BATTERY_TEMP_ADDRESS, "Battery", readings.batteryTempC);
  readings.hasGreenhouseTemp =
      readTemperature(GREENHOUSE_TEMP_ADDRESS, "Greenhouse", readings.greenhouseTempC);

  initBatteryAdc();
  const int raw = analogRead(BATTERY_ADC_PIN);
  if (raw >= 0) {
    Serial.printf("Battery ADC raw value: %d\n", raw);
    const float adcVoltage = (static_cast<float>(raw) / 4095.0f) * ADC_REFERENCE_VOLTS;
    const float correctedVoltage = adcVoltage / VOLTAGE_DIVIDER_RATIO;
    readings.hasBatteryVoltage = true;
    readings.batteryVoltage = correctedVoltage;
    Serial.printf("Battery voltage: %.2f V (ADC %.2f V before divider correction).\n",
                  correctedVoltage, adcVoltage);
  } else {
    Serial.println("Error reading battery voltage (analogRead returned invalid value).");
  }

  return readings;
}

void logSensorReadings() {
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

  const bool wifiReady = connectToWifi();
  if (wifiReady) {
    Serial.print("Wi-Fi ready. IP address: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("Wi-Fi unavailable; API calls will be skipped.");
  }

  logSensorReadings();

  // Placeholder: API server integration will call openDoor()/closeDoor() as needed.
}

void loop() {
  // Door operations will be triggered by the forthcoming API integration.
  delay(1000);
}

//==============================================================================
// Wi-Fi helpers
//==============================================================================
bool checkInternet() {
  WiFiClient client;
  Serial.println("Checking internet reachability...");
  if (!client.connect(PING_ADDRESS, PING_PORT, INTERNET_CHECK_TIMEOUT_MS)) {
    Serial.println("Internet check failed.");
    return false;
  }
  client.stop();
  Serial.println("Internet connection confirmed.");
  return true;
}

size_t collectConfiguredNetworks(NetworkCandidate *candidates, size_t maxCandidates) {
  Serial.println("Scanning for Wi-Fi networks...");
  const int16_t found = WiFi.scanNetworks(/*async=*/false, /*hidden=*/true);
  if (found <= 0) {
    Serial.println("Wi-Fi scan returned no networks or failed.");
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

  if (count == 0) {
    Serial.println("No configured Wi-Fi networks found.");
  } else {
    Serial.print("Available networks: ");
    for (size_t idx = 0; idx < count; ++idx) {
      Serial.printf("%s (%ddBm)%s", candidates[idx].credential->ssid, candidates[idx].rssi,
                    idx + 1 < count ? ", " : "\n");
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
    Serial.println("Wi-Fi TX power set to ~8 dBm.");
  } else {
    Serial.printf("Failed to set Wi-Fi TX power (error %d).\n", static_cast<int>(txPowerResult));
  }

  NetworkCandidate candidates[WIFI_NETWORK_COUNT] = {};
  const size_t candidateCount = collectConfiguredNetworks(candidates, WIFI_NETWORK_COUNT);
  if (candidateCount == 0) {
    return false;
  }
  sortCandidates(candidates, candidateCount);

  for (uint8_t attempt = 0; attempt < MAX_RETRIES; ++attempt) {
    const NetworkCandidate &primary = candidates[0];
    Serial.printf("Attempt %u/%u: Connecting to %s...\n", attempt + 1, MAX_RETRIES, primary.credential->ssid);
    WiFi.begin(primary.credential->ssid, primary.credential->password);

    bool connected = false;
    for (uint8_t waitCycle = 0; waitCycle < STATUS_CHECK_ITERATIONS; ++waitCycle) {
      if (WiFi.status() == WL_CONNECTED) {
        connected = true;
        break;
      }
      Serial.print('.');
      delay(STATUS_CHECK_DELAY_MS);
    }
    Serial.println();

    if (connected) {
      Serial.printf("Connected to %s\n", primary.credential->ssid);
      if (checkInternet()) {
        return true;
      }
      Serial.println("No internet access. Disconnecting...");
      WiFi.disconnect(true);
      delay(1000);
    } else {
      Serial.printf("Failed to connect to %s\n", primary.credential->ssid);
      WiFi.disconnect(true);
      delay(500);
    }
  }

  Serial.println("All connection attempts failed.");
  return false;
}
