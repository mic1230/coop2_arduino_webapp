# Coop Door Controller (ESP32)

An ESP-IDF/Arduino-based automation controller that drives a motorized coop door, serves a local web UI, syncs schedules with NTP, and supports OTA firmware updates. This project started as a MicroPython prototype and was ported to ESP-IDF for the Seeed Studio XIAO ESP32C6 with PlatformIO.

## What It Does
- Controls open/close relays for a coop door with configurable travel time.
- Reads SHT31 temperature/humidity plus battery voltage for health monitoring.
- Hosts a captive-portal-style Wi-Fi setup flow and a full-featured web interface for manual control, schedules, and diagnostics.
- Persists per-user configuration (Wi-Fi, timezone, solar schedule, overrides) in NVS/LittleFS.
- Supports secure OTA firmware uploads through the web UI.

## Hardware & Prerequisites
- Seeed Studio XIAO ESP32C6 (or another ESP32 variant with the same pinout edits reflected in `DoorPinConfig`).
- Two relay channels wired to the defined open/close GPIOs (`DEFAULT_DOOR_PIN_ASSIGNMENTS` in `src/main.cpp`).
- SHT31 sensor on I2C pins defined in `doorPinConfig`.
- Battery/voltage sensing circuit that matches the configured divider (3.3 V ref, 10k / (10k + 2k)).
- PlatformIO CLI or VS Code with the PlatformIO extension.

## Building & Flashing
1. Install [PlatformIO](https://platformio.org/install).
2. Connect the controller over USB.
3. From this directory run:
   ```bash
   pio run -t upload
   ```
4. Monitor serial output with:
   ```bash
   pio device monitor
   ```

## Wi-Fi Credentials & Privacy
The firmware can remember credentials that are entered through the captive portal, or you can optionally seed known networks at compile time:

- Runtime storage: The controller saves credentials to `/wifi_config.json` on LittleFS with the structure:
  ```json
  {"ssid": "YourNetwork", "password": "YourPassword"}
  ```
  The configuration UI exposes actions to save/erase this file.

- Compile-time defaults: `src/main.cpp` defines `WIFI_NETWORKS`. The public build ships with placeholder values:
  ```cpp
  constexpr NetworkCredential WIFI_NETWORKS[] = {
      {"YOUR_HOME_NETWORK", "CHANGE_ME"},
  };
  ```
  Update the array locally if you want the device to auto-connect before running the portal, but do **not** commit real credentials.

Because the repository history was rebuilt for this release, no prior commits (and no legacy secrets) are exposed.

## Web Application Overview
- **Captive portal**: When the board fails to join Wi-Fi it exposes the `CoopDoorSetup` AP and DNS redirect so phones/laptops can join self-contained setup pages.
- **Dashboard**: Displays current door state, last motion, battery voltage, and sensor readings pulled from the device.
- **Scheduling**: Choose between manual, fixed-time, or solar-based opening/closing. Time synchronization relies on NTP with the timezone offsets in the firmware.
- **History export**: CSV buffer of the most recent door events can be downloaded for analysis.
- **OTA**: Upload a compiled `.bin` and confirm the checksum before swapping partitions.

## Making It Your Own
1. Copy `platformio.ini` env `seeed_xiao_esp32c6` if you need another board.
2. Update `DoorPinConfig` defaults in `src/main.cpp` for different relays or I2C pins.
3. Customize the captive portal texts and web assets in `src/web_assets.h`.
4. Use `data/` or a dedicated LittleFS image if you need to pre-provision more files.

## Release & Tagging
Public releases are tagged. For this sanitized drop, use:
```bash
git tag -a public-v1 -m "Public release v1"
git push origin public-v1
```
If you plan to make the entire repo public, ensure you have force-pushed the rewritten history (see notes in the issue request) before toggling repository visibility.
