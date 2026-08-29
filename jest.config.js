'use strict';

module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/tests/**/*.test.js'],
  globalSetup: '<rootDir>/tests/globalSetup.js',
  globalTeardown: '<rootDir>/tests/globalTeardown.js',
  setupFiles: ['<rootDir>/tests/setupEnv.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setupAfterEnv.js'],
  restoreMocks: true,
  clearMocks: true,
  testTimeout: 30000,
  coveragePathIgnorePatterns: [
    '/node_modules/',
    '/tests/',
    'src/docs/',
    // Process entry points and one-shot CLI scripts: exercised by running them,
    // not by unit tests, so they would only dilute the numbers below.
    'src/index.js',
    'src/gateway/index.js',
    'src/scripts/',
  ],
  collectCoverageFrom: ['src/**/*.js'],
  coverageReporters: ['text', 'lcov'],
  coverageThreshold: {
    global: {
      statements: 70,
      branches: 60,
      functions: 70,
      lines: 70,
    },
  },
  verbose: false,
};
