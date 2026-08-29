'use strict';

const CircuitBreaker = require('../../src/gateway/circuitBreaker');

describe('CircuitBreaker', () => {
  test('starts closed', () => {
    const breaker = new CircuitBreaker();
    expect(breaker.state).toBe('closed');
    expect(breaker.isOpen()).toBe(false);
  });

  test('opens once the failure threshold is reached', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(true);
    expect(breaker.state).toBe('open');
  });

  test('a success resets the failure count', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3 });
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.isOpen()).toBe(false);
    expect(breaker.failures).toBe(1);
  });

  test('half-opens after the cooldown and lets one probe through', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 5000 });
      breaker.recordFailure();
      expect(breaker.isOpen()).toBe(true);

      jest.setSystemTime(new Date('2026-01-01T00:00:06Z'));
      expect(breaker.isOpen()).toBe(false);
      expect(breaker.state).toBe('half_open');
    } finally {
      jest.useRealTimers();
    }
  });

  test('a failed probe re-opens the circuit immediately', () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
    try {
      const breaker = new CircuitBreaker({ failureThreshold: 10, cooldownMs: 1000 });
      breaker.state = 'half_open';
      breaker.recordFailure();
      expect(breaker.state).toBe('open');
      expect(breaker.isOpen()).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a successful probe closes the circuit', () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, cooldownMs: 0 });
    breaker.recordFailure();
    breaker.recordSuccess();
    expect(breaker.state).toBe('closed');
    expect(breaker.snapshot()).toEqual({
      name: 'upstream',
      state: 'closed',
      failures: 0,
      openedAt: null,
    });
  });
});
