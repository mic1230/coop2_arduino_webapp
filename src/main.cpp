#include <Arduino.h>

// put function declarations here:
int myFunction(int, int);

void setup() {
  Serial.begin(115200);
  while (!Serial) {
    // wait for serial port to connect (needed for native USB ports)
  }
  Serial.println("Setup complete.");
}

void loop() {
  static uint32_t counter = 0;
  Serial.print("Heartbeat ");
  Serial.println(counter++);
  delay(1000);  // wait one second before printing again
}

// put function definitions here:
int myFunction(int x, int y) {
  return x + y;
}
