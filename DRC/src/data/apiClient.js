const axios = require('axios');
const { validateWithSchema } = require('../validation');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RateLimiter {
  constructor({ maxRequests, intervalMs }) {
    this.maxRequests = maxRequests;
    this.intervalMs = intervalMs;
    this.queue = Promise.resolve();
    this.timestamps = [];
  }

  async schedule(fn) {
    this.queue = this.queue.then(async () => {
      const now = Date.now();
      this.timestamps = this.timestamps.filter((t) => now - t < this.intervalMs);
      if (this.timestamps.length >= this.maxRequests) {
        const wait = this.intervalMs - (now - this.timestamps[0]);
        if (wait > 0) await sleep(wait);
      }
      this.timestamps.push(Date.now());
    }).catch(() => {});

    await this.queue;
    return fn();
  }
}

function createApiClient({
  baseURL,
  apiKey,
  maxRetries = 3,
  backoffMs = 400,
  timeoutMs = 8000,
  rateLimitPerMinute = 50,
  schema,
  transport,
} = {}) {
  const limiter = new RateLimiter({ maxRequests: rateLimitPerMinute, intervalMs: 60_000 });
  const instance = transport || axios.create({
    baseURL,
    timeout: timeoutMs,
    headers: apiKey ? { 'x-rapidapi-key': apiKey } : undefined,
  });

  async function request(config) {
    let attempt = 0;
    let error;

    while (attempt <= maxRetries) {
      try {
        const res = await limiter.schedule(() => instance.request(config));
        if (schema) validateWithSchema(res.data, schema, { path: `${config.url || ''}` });
        return res.data;
      } catch (err) {
        error = err;
        attempt += 1;
        if (attempt > maxRetries) break;
        const jitter = Math.floor(Math.random() * 50);
        await sleep(backoffMs * attempt + jitter);
      }
    }

    const message = error?.message || 'Unknown error';
    const status = error?.response?.status;
    const detail = status ? `${status} ${message}` : message;
    throw new Error(`API request failed after ${maxRetries} retries: ${detail}`);
  }

  return {
    get: (url, params = {}) => request({ method: 'GET', url, params }),
    post: (url, data = {}) => request({ method: 'POST', url, data }),
  };
}

module.exports = { createApiClient, RateLimiter };
