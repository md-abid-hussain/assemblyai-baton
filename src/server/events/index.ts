import "server-only";

/** The outbox module's public surface (SAAS §7.1). WP19·3. */
export { createDbDomainEvents, EVENT_ID_PREFIX, pendingEvents, type DbDomainEventsOptions } from "./outbox";
