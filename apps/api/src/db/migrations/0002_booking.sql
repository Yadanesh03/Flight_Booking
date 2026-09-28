CREATE TABLE `booking_seats` (
	`booking_id` bigint unsigned NOT NULL,
	`flight_seat_id` bigint unsigned NOT NULL,
	`seat_number` varchar(4) NOT NULL,
	`price` decimal(10,2) NOT NULL,
	`passenger_name` varchar(100) NOT NULL,
	`passenger_age` tinyint unsigned NOT NULL,
	CONSTRAINT `booking_seats_booking_id_flight_seat_id_pk` PRIMARY KEY(`booking_id`,`flight_seat_id`),
	CONSTRAINT `uq_booked_seat` UNIQUE(`flight_seat_id`)
);
--> statement-breakpoint
CREATE TABLE `bookings` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`booking_ref` char(6) NOT NULL,
	`user_id` bigint unsigned NOT NULL,
	`flight_id` bigint unsigned NOT NULL,
	`status` enum('PENDING','CONFIRMED','FAILED') NOT NULL,
	`failure_reason` varchar(40),
	`total_amount` decimal(12,2) NOT NULL DEFAULT '0',
	`currency` char(3) NOT NULL DEFAULT 'INR',
	`idempotency_key` char(36) NOT NULL,
	`request_hash` char(64) NOT NULL,
	`payment_method` enum('UPI','CARD','NETBANKING') NOT NULL,
	`payment_ref` varchar(40),
	`flight_snapshot` json,
	`confirmed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `bookings_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_booking_ref` UNIQUE(`booking_ref`),
	CONSTRAINT `uq_user_idempotency` UNIQUE(`user_id`,`idempotency_key`)
);
--> statement-breakpoint
CREATE TABLE `flight_seats` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`flight_id` bigint unsigned NOT NULL,
	`seat_id` bigint unsigned NOT NULL,
	`seat_number` varchar(4) NOT NULL,
	`row_no` smallint unsigned NOT NULL,
	`column_code` char(1) NOT NULL,
	`cabin_class` enum('ECONOMY','BUSINESS') NOT NULL,
	`seat_type` enum('WINDOW','MIDDLE','AISLE') NOT NULL,
	`price` decimal(10,2) NOT NULL,
	`status` enum('AVAILABLE','BOOKED') NOT NULL DEFAULT 'AVAILABLE',
	`booking_id` bigint unsigned,
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `flight_seats_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_flight_seat` UNIQUE(`flight_id`,`seat_id`),
	CONSTRAINT `uq_flight_seat_number` UNIQUE(`flight_id`,`seat_number`)
);
--> statement-breakpoint
ALTER TABLE `booking_seats` ADD CONSTRAINT `fk_bs_booking` FOREIGN KEY (`booking_id`) REFERENCES `bookings`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `booking_seats` ADD CONSTRAINT `fk_bs_seat` FOREIGN KEY (`flight_seat_id`) REFERENCES `flight_seats`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_user_created` ON `bookings` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_flight` ON `bookings` (`flight_id`);--> statement-breakpoint
CREATE INDEX `idx_flight_status` ON `flight_seats` (`flight_id`,`status`);