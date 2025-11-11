#!/usr/bin/env python3
"""
Quick helper to grab ESP32 serial output right after flashing.
Run this immediately after `platformio run -t upload` to snag the boot log/IP.
"""

from __future__ import annotations

import argparse
import sys
import time

import serial
from serial.tools import list_ports


def pulse_reset(port: serial.Serial, delay: float = 0.05) -> None:
    """Toggle DTR/RTS to kick the ESP32C3 into reboot."""
    port.dtr = False
    port.rts = True
    time.sleep(delay)
    port.dtr = True
    port.rts = False
    time.sleep(delay)


def stream_serial(port: str, baud: int, duration: float) -> bool:
    got_data = False
    with serial.Serial(port, baudrate=baud, timeout=0.2) as ser:
        pulse_reset(ser)
        print(
            f"\n=== Listening on {port} @ {baud} for {duration:.0f}s "
            "right after flashing ==="
        )
        deadline = time.time() + duration
        while time.time() < deadline:
            data = ser.readline()
            if data:
                got_data = True
                sys.stdout.write(data.decode("utf-8", "replace"))
                sys.stdout.flush()
    return got_data


def discover_ports(explicit: str | None) -> list[str]:
    if explicit:
        return [explicit]

    ports = [p.device for p in list_ports.comports()]
    if not ports:
        raise SystemExit("No serial ports detected. Plug in the controller and retry.")
    print("Auto-detected serial ports:", ", ".join(ports))
    return ports


def main() -> None:
    parser = argparse.ArgumentParser(description="Read coop controller serial output.")
    parser.add_argument(
        "-p",
        "--port",
        default=None,
        help="Serial port. Leave unset to auto-scan available ports.",
    )
    parser.add_argument(
        "-b", "--baud", type=int, default=115200, help="Baud rate (default: %(default)s)"
    )
    parser.add_argument(
        "-d",
        "--duration",
        type=float,
        default=30.0,
        help="Seconds to listen after reset (default: %(default)s)",
    )
    args = parser.parse_args()

    ports = discover_ports(args.port)
    any_data = False

    for port in ports:
        try:
            if stream_serial(port, args.baud, args.duration):
                any_data = True
                break
        except serial.SerialException as exc:
            print(f"Serial error on {port}: {exc}")

    if not any_data:
        sys.exit("No serial output captured. Specify --port to target a device explicitly.")


if __name__ == "__main__":
    main()
