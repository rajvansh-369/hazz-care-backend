'use strict';

const net = require('net');

/**
 * Sends one HTTP/1.1 request over a plain socket, with the request target written
 * exactly as given. supertest and fetch parse the URL first, which collapses "..",
 * "." and backslashes before the request leaves, so they cannot send the targets a
 * hand-written client, a proxy or a misconfigured base URL can.
 *
 * @param {number} port
 * @param {string} method
 * @param {string} target the request target, byte for byte (e.g. "//api/v1/auth/login")
 * @param {object} [body] sent as JSON; omitted for GET, HEAD, OPTIONS and TRACE
 * @returns {Promise<{ status: number, headers: object, text: string, body: object|null }>}
 */
const rawRequest = (port, method, target, body = {}) =>
  new Promise((resolve, reject) => {
    const hasBody = !['GET', 'HEAD', 'OPTIONS', 'TRACE'].includes(method);
    const payload = hasBody ? JSON.stringify(body) : '';
    const socket = net.connect(port, '127.0.0.1');
    let raw = '';
    socket.setEncoding('utf8');
    socket.setTimeout(10000, () => socket.destroy(new Error(`${method} ${target} timed out`)));
    socket.on('data', (chunk) => {
      raw += chunk;
    });
    socket.on('error', reject);
    socket.on('end', () => {
      const split = raw.indexOf('\r\n\r\n');
      const [statusLine, ...headerLines] = raw.slice(0, split).split('\r\n');
      const headers = {};
      headerLines.forEach((line) => {
        const colon = line.indexOf(':');
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      });
      const text = raw.slice(split + 4);
      let parsed = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch (error) {
        parsed = null;
      }
      resolve({ status: Number(statusLine.split(' ')[1]), headers, text, body: parsed });
    });
    const head = [`${method} ${target} HTTP/1.1`, 'Host: localhost', 'Connection: close'];
    if (hasBody) {
      head.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(payload)}`);
    }
    socket.write(`${head.join('\r\n')}\r\n\r\n${payload}`);
  });

module.exports = rawRequest;
