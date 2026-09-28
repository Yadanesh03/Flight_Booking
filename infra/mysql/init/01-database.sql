-- Runs once on first container start (docker-entrypoint-initdb.d).
-- Dev-only credentials; override for any non-local environment.
CREATE DATABASE IF NOT EXISTS flight_booking      CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE IF NOT EXISTS flight_booking_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;

CREATE USER IF NOT EXISTS 'app'@'%' IDENTIFIED BY 'app_dev_password';
GRANT ALL PRIVILEGES ON flight_booking.*      TO 'app'@'%';
GRANT ALL PRIVILEGES ON flight_booking_test.* TO 'app'@'%';
FLUSH PRIVILEGES;
