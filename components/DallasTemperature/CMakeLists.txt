idf_component_register(
    SRCS "DallasTemperature.cpp"
    INCLUDE_DIRS "."
    REQUIRES arduino-esp32 OneWire
)
