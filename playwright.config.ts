import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright e2e (DESIGN §9.3; specs owned by WP12 in tests/e2e/**).
 * - Default: starts `next dev` with E2E_FAKE_UPSTREAM=1 and PAYMENTS_MODE=mock ($0).
 * - E2E_BASE_URL=https://app-….zerops.app runs against a deployed app instead (spec 2, RUN_LIVE=1).
 */
const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";
const external = Boolean(process.env.E2E_BASE_URL);

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 180_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  use: {
    baseURL,
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"],
        },
        permissions: ["microphone"],
      },
    },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
  ...(external
    ? {}
    : {
        webServer: {
          command: "npm run dev",
          url: `${baseURL}/api/health`,
          reuseExistingServer: !process.env.CI,
          timeout: 180_000,
          env: { E2E_FAKE_UPSTREAM: "1", PAYMENTS_MODE: "mock" },
        },
      }),
});
