'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const https = require('node:https');
const test = require('node:test');

const proxyCapi = require('../lib/proxy-capi');

function createResponseSink() {
  return {
    statusCode: null,
    headers: null,
    body: '',
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk) {
      if (chunk) this.body += chunk;
    },
  };
}

test('forwardToCAPI strips transfer-encoding, recomputes content-length, and preserves authorization headers', () => {
  const calls = [];
  const originalHttpsRequest = https.request;
  const originalHttpRequest = http.request;
  const savedEnv = {
    CAPI_PROTOCOL: process.env.CAPI_PROTOCOL,
    CAPI_HOST: process.env.CAPI_HOST,
    CAPI_PORT: process.env.CAPI_PORT,
  };

  process.env.CAPI_PROTOCOL = 'https';
  process.env.CAPI_HOST = 'api.githubcopilot.com';
  process.env.CAPI_PORT = '8443';

  https.request = (opts, callback) => {
    calls.push(opts);
    const upstream = {
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      pipe(res) {
        res.end('{"ok":true}');
      },
      on() {},
    };
    callback(upstream);
    return {
      on() {},
      write() {},
      end() {},
    };
  };
  http.request = () => { throw new Error('http.request should not be used for https'); };

  try {
    const res = createResponseSink();
    proxyCapi.forwardToCAPI({ hello: 'world' }, {
      authorization: 'Bearer secret',
      'transfer-encoding': 'chunked',
    }, res, '/v1/chat/completions', 'POST');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].hostname, 'api.githubcopilot.com');
    assert.equal(calls[0].port, 8443);
    assert.equal(calls[0].headers.authorization, 'Bearer secret');
    assert.equal(calls[0].headers['transfer-encoding'], undefined);
    assert.equal(calls[0].headers['content-length'], Buffer.byteLength('{"hello":"world"}'));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body, '{"ok":true}');
  } finally {
    https.request = originalHttpsRequest;
    http.request = originalHttpRequest;
    process.env.CAPI_PROTOCOL = savedEnv.CAPI_PROTOCOL;
    process.env.CAPI_HOST = savedEnv.CAPI_HOST;
    process.env.CAPI_PORT = savedEnv.CAPI_PORT;
  }
});

test('forwardToCAPI supports http protocol for local test servers', () => {
  const calls = [];
  const originalHttpsRequest = https.request;
  const originalHttpRequest = http.request;
  const savedEnv = {
    CAPI_PROTOCOL: process.env.CAPI_PROTOCOL,
    CAPI_HOST: process.env.CAPI_HOST,
    CAPI_PORT: process.env.CAPI_PORT,
  };

  process.env.CAPI_PROTOCOL = 'http';
  process.env.CAPI_HOST = '127.0.0.1';
  process.env.CAPI_PORT = '8080';

  http.request = (opts, callback) => {
    calls.push(opts);
    const upstream = {
      statusCode: 204,
      headers: {},
      pipe(res) { res.end(); },
      on() {},
    };
    callback(upstream);
    return { on() {}, write() {}, end() {} };
  };
  https.request = () => { throw new Error('https.request should not be used for http'); };

  try {
    const res = createResponseSink();
    proxyCapi.forwardToCAPI(null, { 'content-type': 'application/json' }, res, '/models', 'GET');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].port, 8080);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].headers['content-length'], undefined);
    assert.equal(calls[0].headers['content-type'], undefined);
    assert.equal(res.statusCode, 204);
  } finally {
    https.request = originalHttpsRequest;
    http.request = originalHttpRequest;
    process.env.CAPI_PROTOCOL = savedEnv.CAPI_PROTOCOL;
    process.env.CAPI_HOST = savedEnv.CAPI_HOST;
    process.env.CAPI_PORT = savedEnv.CAPI_PORT;
  }
});