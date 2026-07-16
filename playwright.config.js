const { defineConfig, devices } = require('@playwright/test');

// Serves the project root over HTTP so the app's localStorage works
// (file:// has inconsistent storage behaviour across browsers).
const PORT = 8123;

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  workers: 4,           // cap parallelism — one dev server, avoids load-starved flakes
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'on-first-retry',
    // Fly-to navigation defaults ON in the app; the suite pre-seeds it OFF so
    // every jump stays the instant cut the tests were written against. (Not
    // via reducedMotion emulation: the app's reduce CSS turns every style
    // change into a 0.01ms transition, which lags rects by a frame — racy.)
    // Suites testing the animation itself override with a clean storageState.
    storageState: {
      cookies: [],
      origins: [{
        origin: `http://localhost:${PORT}`,
        localStorage: [{ name: 'whiteboard:settings', value: '{"flyTo":false}' }],
      }],
    },
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: `python3 -m http.server ${PORT}`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
