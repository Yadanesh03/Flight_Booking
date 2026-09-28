-- Cross-module foreign keys (Architecture spec 8.3). They exist for database integrity only and
-- would be dropped if the booking module were extracted into its own service (spec Section 25).
-- They live in a hand-written migration because declaring them in the drizzle schema would require
-- the booking module to import the flights/auth modules' schema files (forbidden by the boundary rule).
ALTER TABLE `flight_seats` ADD CONSTRAINT `fk_fs_flight` FOREIGN KEY (`flight_id`) REFERENCES `flights`(`id`);--> statement-breakpoint
ALTER TABLE `flight_seats` ADD CONSTRAINT `fk_fs_seat` FOREIGN KEY (`seat_id`) REFERENCES `seats`(`id`);--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `fk_bookings_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`);--> statement-breakpoint
ALTER TABLE `bookings` ADD CONSTRAINT `fk_bookings_flight` FOREIGN KEY (`flight_id`) REFERENCES `flights`(`id`);
