#include <Arduino.h>

extern void setup();
extern void loop();

extern "C" void app_main(void) {
  initArduino();
  setup();
  for (;;) {
    loop();
    delay(1);
  }
}
