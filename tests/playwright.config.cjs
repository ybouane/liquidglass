const { defineConfig } = require('@playwright/test');
module.exports = defineConfig({
  testDir: '.', testMatch: '*.spec.cjs', workers: 1,
  use: { baseURL: 'http://127.0.0.1:4173', viewport: { width: 400, height: 600 } },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }, { name: 'webkit', use: { browserName: 'webkit' } }],
  webServer: { command: 'node tests/server.cjs', cwd: require('node:path').resolve(__dirname, '..'), url: 'http://127.0.0.1:4173/tests/nested.html', reuseExistingServer: false },
});
