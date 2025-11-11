from pathlib import Path
from SCons.Script import Import

Import("env")

PROJECT_DIR = Path(env.subst("$PROJECT_DIR"))
BUILD_DIR = Path(env.subst("$BUILD_DIR"))
LOG_FILE = PROJECT_DIR / "cert_gen.log"
CERTS = {
    "https_server": PROJECT_DIR / "managed_components/espressif__esp_insights/server_certs/https_server.crt",
    "rmaker_mqtt_server": PROJECT_DIR / "managed_components/espressif__esp_rainmaker/server_certs/rmaker_mqtt_server.crt",
    "rmaker_claim_service_server": PROJECT_DIR / "managed_components/espressif__esp_rainmaker/server_certs/rmaker_claim_service_server.crt",
    "rmaker_ota_server": PROJECT_DIR / "managed_components/espressif__esp_rainmaker/server_certs/rmaker_ota_server.crt",
}
ASM_TEMPLATE = """    .section .rodata
    .align 4
    .global _binary_{symbol}_start
    .global _binary_{symbol}_end
    .global _binary_{symbol}_length
_binary_{symbol}_start:
    .incbin \"{crt_path}\"
_binary_{symbol}_end:
_binary_{symbol}_length:
    .long _binary_{symbol}_end - _binary_{symbol}_start
"""

log_entries = []
for name, data_file in CERTS.items():
    if not data_file.exists():
        log_entries.append(f"missing:{data_file}")
        continue
    output_file = BUILD_DIR / f"{name}.crt.S"
    output_file.parent.mkdir(parents=True, exist_ok=True)
    rendered = ASM_TEMPLATE.format(
        symbol=f"{name}_crt", crt_path=data_file.as_posix()
    )
    if not output_file.exists() or output_file.read_text() != rendered:
        log_entries.append(f"write:{output_file}")
        output_file.write_text(rendered)
    else:
        log_entries.append(f"skip:{output_file}")

LOG_FILE.write_text("\n".join(log_entries) + "\n")
