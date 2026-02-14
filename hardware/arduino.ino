// PIN DEFINITIONS 
const int AIN1 = 2;   // Motor Direction Pin 1
const int AIN2 = 3;   // Motor Direction Pin 2
const int PWMA = 5;   // Motor Speed (PWM) Pin - Must be a ~ pin
const int Trig = 4;   // Ultrasonic Trigger Pin
const int Echo = 6;   // Ultrasonic Echo Pin

// VARIABLES 
long duration; // To store the time taken for the wave to travel
int distance;  // To store the calculated distance in cm

void setup() {
  // 1. Setup Motor Pins as Outputs
  pinMode(AIN1, OUTPUT);
  pinMode(AIN2, OUTPUT);
  pinMode(PWMA, OUTPUT);

  // 2. Setup Ultrasonic Pins
  pinMode(Trig, OUTPUT);
  pinMode(Echo, INPUT);

  // 3. Start Serial Monitor for debugging
  Serial.begin(9600);
  
  // 4. Initial Motor State (Set direction forward)
  // To vibrate, the motor just needs to spin in one direction constantly
  digitalWrite(AIN1, HIGH);
  digitalWrite(AIN2, LOW);
  
  Serial.println("System Initialized: Echo-Sight Active");
}

void loop() {
  // STEP 1: MEASURE DISTANCE 
  // Clear the Trig pin
  digitalWrite(Trig, LOW);
  delayMicroseconds(2);

  // Send a 10 microsecond pulse to trigger the sensor
  digitalWrite(Trig, HIGH);
  delayMicroseconds(10);
  digitalWrite(Trig, LOW);

  // Read the pulse from Echo pin (returns duration in microseconds)
  duration = pulseIn(Echo, HIGH);

  // Calculate distance: Distance = (Time * Speed of Sound) / 2
  // Speed of sound is approx 0.034 cm/microsecond
  distance = duration * 0.034 / 2;

  // STEP 2: PRINT TO SERIAL MONITOR 
  Serial.print("Distance: ");
  Serial.print(distance);
  Serial.println(" cm");

  // STEP 3: HAPTIC FEEDBACK LOGIC 
  
  // SAFETY CHECK: If distance reads 0, it usually means 'out of range' or error.
  // We treat 0 as "Safe" to prevent false alarms.
  
  if (distance > 100 || distance <= 0) {
    // ZONE 1: SAFE (Farther than 100cm / 1 meter)
    // Motor OFF
    analogWrite(PWMA, 0); 
    
  } else if (distance > 40 && distance <= 100) {
    // ZONE 2: WARNING (Between 40cm and 1 meter)
    // Motor Speed: Medium (Gentle Vibration)
    analogWrite(PWMA, 120); // Value between 0-255
    
  } else if (distance <= 40) {
    // ZONE 3: DANGER (Closer than 40cm)
    // Motor Speed: MAX (Strong Vibration)
    analogWrite(PWMA, 255); // Full speed
  }

  // Small delay to stabilize sensor readings (don't ping too fast)
  delay(100); 
}