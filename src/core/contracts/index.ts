/**
 * contracts/index.ts - barrel for every frozen contract (DESIGN §4.1, §4.4; TASKS §2).
 * Additive per-WP types go in src/core/contracts/ext/<wp>-<topic>.ts, never here.
 */
export * from "./errors";
export * from "./case";
export * from "./turns";
export * from "./scenario";
export * from "./run";
export * from "./tools";
export * from "./takeover";
export * from "./events";
export * from "./extract";
export * from "./eval";
export * from "./api";
export type * from "./services";
