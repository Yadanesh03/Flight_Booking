import { defineConfig } from 'drizzle-kit';

// Tooling only: aggregates the schema files owned by each module so drizzle-kit can generate
// migrations. Runtime code never imports this file.
export default defineConfig({
  dialect: 'mysql',
  schema: './src/modules/*/schema.ts',
  out: './src/db/migrations',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? 'mysql://app:app_dev_password@localhost:3306/flight_booking'
  }
});
