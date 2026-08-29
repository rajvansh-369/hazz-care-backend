'use strict';

const STATES = { CLOSED: 'closed', OPEN: 'open', HALF_OPEN: 'half_open' };

/**
 * Minimal circuit breaker used by the gateway to stop hammering an upstream that
 * is already failing. After `failureThreshold` consecutive failures the circuit
 * opens and requests are rejected with 503 for `cooldownMs`; the next request
 * after the cooldown is let through as a probe (half-open).
 */
class CircuitBreaker {
  constructor({ name = 'upstream', failureThreshold = 5, cooldownMs = 15000 } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.cooldownMs = cooldownMs;
    this.state = STATES.CLOSED;
    this.failures = 0;
    this.openedAt = null;
  }

  /** @returns {boolean} true when requests must be rejected immediately. */
  isOpen() {
    if (this.state !== STATES.OPEN) {
      return false;
    }
    if (Date.now() - this.openedAt >= this.cooldownMs) {
      this.state = STATES.HALF_OPEN;
      return false;
    }
    return true;
  }

  recordSuccess() {
    this.failures = 0;
    this.openedAt = null;
    this.state = STATES.CLOSED;
  }

  recordFailure() {
    this.failures += 1;
    if (this.state === STATES.HALF_OPEN || this.failures >= this.failureThreshold) {
      this.state = STATES.OPEN;
      this.openedAt = Date.now();
    }
  }

  snapshot() {
    return {
      name: this.name,
      state: this.state,
      failures: this.failures,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
    };
  }
}

CircuitBreaker.STATES = STATES;

module.exports = CircuitBreaker;
