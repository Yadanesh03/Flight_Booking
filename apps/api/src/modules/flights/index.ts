/** Public API of the `flights` module (Section 3.3). Everything else in this folder is private. */
export { flightsRouter } from './flights.routes.js';
export { flightsAdminRouter } from './admin.routes.js';
export { flightsService, type Bookability, type BookabilityReason, type FlightLayout, type FlightSnapshot } from './flights.service.js';
/** Seed-script entry points (airports and aircraft are created through the same services as the admin API). */
export { catalogService } from './catalog.service.js';
export { flightsAdminService } from './admin.service.js';
