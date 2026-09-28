CREATE TABLE `aircraft` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`aircraft_code` varchar(20) NOT NULL,
	`model` varchar(40) NOT NULL,
	`layout_columns` varchar(20) NOT NULL,
	`total_rows` smallint unsigned NOT NULL,
	`business_rows` smallint unsigned NOT NULL DEFAULT 0,
	`seat_count` smallint unsigned NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `aircraft_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_aircraft_code` UNIQUE(`aircraft_code`)
);
--> statement-breakpoint
CREATE TABLE `airports` (
	`code` char(3) NOT NULL,
	`name` varchar(120) NOT NULL,
	`city` varchar(80) NOT NULL,
	`country` varchar(80) NOT NULL,
	`timezone` varchar(40) NOT NULL,
	CONSTRAINT `airports_code` PRIMARY KEY(`code`)
);
--> statement-breakpoint
CREATE TABLE `flights` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`flight_number` varchar(10) NOT NULL,
	`aircraft_id` bigint unsigned NOT NULL,
	`source_airport` char(3) NOT NULL,
	`destination_airport` char(3) NOT NULL,
	`departure_time` datetime(3) NOT NULL,
	`arrival_time` datetime(3) NOT NULL,
	`base_price` decimal(10,2) NOT NULL,
	`status` enum('DRAFT','SCHEDULED','CANCELLED') NOT NULL DEFAULT 'DRAFT',
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
	CONSTRAINT `flights_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_flight_departure` UNIQUE(`flight_number`,`departure_time`),
	CONSTRAINT `chk_route` CHECK(`flights`.`source_airport` <> `flights`.`destination_airport`),
	CONSTRAINT `chk_times` CHECK(`flights`.`arrival_time` > `flights`.`departure_time`),
	CONSTRAINT `chk_price` CHECK(`flights`.`base_price` > 0)
);
--> statement-breakpoint
CREATE TABLE `seats` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`aircraft_id` bigint unsigned NOT NULL,
	`seat_number` varchar(4) NOT NULL,
	`row_no` smallint unsigned NOT NULL,
	`column_code` char(1) NOT NULL,
	`cabin_class` enum('ECONOMY','BUSINESS') NOT NULL,
	`seat_type` enum('WINDOW','MIDDLE','AISLE') NOT NULL,
	CONSTRAINT `seats_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_seat` UNIQUE(`aircraft_id`,`seat_number`)
);
--> statement-breakpoint
ALTER TABLE `flights` ADD CONSTRAINT `fk_flights_aircraft` FOREIGN KEY (`aircraft_id`) REFERENCES `aircraft`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `flights` ADD CONSTRAINT `fk_flights_src` FOREIGN KEY (`source_airport`) REFERENCES `airports`(`code`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `flights` ADD CONSTRAINT `fk_flights_dst` FOREIGN KEY (`destination_airport`) REFERENCES `airports`(`code`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `seats` ADD CONSTRAINT `fk_seats_aircraft` FOREIGN KEY (`aircraft_id`) REFERENCES `aircraft`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_search` ON `flights` (`source_airport`,`destination_airport`,`status`,`departure_time`);