'use strict';

const config = require('../config/config');
const CircuitBreaker = require('./circuitBreaker');

/**
 * Service registry. Adding a second microservice is a matter of appending an
 * entry here: the gateway derives routing, health aggregation and circuit
 * breaking from this list.
 */
const services = [
  {
    name: 'core',
    prefix: config.apiPrefix,
    target: config.gateway.services.core,
    healthPath: `${config.apiPrefix}/health/ready`,
    breaker: new CircuitBreaker({ name: 'core', failureThreshold: 5, cooldownMs: 15000 }),
  },
];

const getService = (name) => services.find((service) => service.name === name);

module.exports = { services, getService };
