const int trigPin = 5;
const int echoPin = 4;
const int buzzerPin = 3;

// VOLUME CONTROL (0-255)
// 5 is quiet (good for ear), 100 is loud.
int volume = 20; 

void setup() {
  Serial.begin(115200); // Faster communication just in case
  pinMode(trigPin, OUTPUT);
  pinMode(echoPin, INPUT);
  pinMode(buzzerPin, OUTPUT);
}

void loop() {
  long duration, distance;

  // 1. Measure Distance
  digitalWrite(trigPin, LOW);
  delayMicroseconds(2);
  digitalWrite(trigPin, HIGH);
  delayMicroseconds(10);
  digitalWrite(trigPin, LOW);

  duration = pulseIn(echoPin, HIGH);
  distance = (duration / 2) / 29.1;

  Serial.println(distance); // Helpful for debugging

  // 2. The "Heartbeat" Logic
  if (distance > 0 && distance < 50) {
    
    // Calculate the delay based on distance
    // Closer = Shorter Delay (Faster Beeps)
    // 5cm away = 50ms delay (Fast!)
    // 50cm away = 600ms delay (Slow)
    int heartbeatDelay = map(distance, 0, 50, 50, 600);
    heartbeatDelay = constrain(heartbeatDelay, 50, 600); // Safety cap

    // The "Thump"
    analogWrite(buzzerPin, volume); 
    delay(50); // Short, sharp beep (50ms)
    
    // The "Rest"
    analogWrite(buzzerPin, 0);
    delay(heartbeatDelay); // Variable wait time

  } else {
    // Silence if clear
    analogWrite(buzzerPin, 0);
    delay(100); 
  }
}