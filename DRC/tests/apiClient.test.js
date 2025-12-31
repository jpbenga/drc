const assert = require('assert');
const { createApiClient } = require('../src/data/apiClient');

async function run() {
  let attempts = 0;
  const client = createApiClient({
    transport: {
      request: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('temporary');
        return { data: { ok: true, count: attempts } };
      },
    },
    maxRetries: 4,
    backoffMs: 10,
  });

  const res = await client.get('/test');
  assert.deepStrictEqual(res, { ok: true, count: 3 });
  console.log('✅ apiClient retry logic passed');
}

run().catch((err) => {
  console.error('apiClient test failed', err);
  process.exit(1);
});
