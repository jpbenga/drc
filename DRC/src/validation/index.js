const { fixtureSchema, oddsSchema, fixturesResponseSchema } = require('./schemas');

function formatIssues(issues = [], prefix = '') {
  return (
    prefix +
    issues
      .map((i) => {
        const path = i.path.join('.') || 'root';
        return `${path}: ${i.message}`;
      })
      .join('; ')
  );
}

function parseWithSchema(data, schema, { path } = {}) {
  if (!schema) return data;
  if (typeof schema === 'function' && !schema.safeParse) return schema(data, { path });
  const res = schema.safeParse ? schema.safeParse(data) : null;
  if (res && !res.success) {
    throw new Error(formatIssues(res.error.issues, path ? `${path}: ` : ''));
  }
  return res ? res.data : data;
}

function validateFixture(fixture, { path } = {}) {
  return parseWithSchema(fixture, fixtureSchema, { path });
}

function validateOdds(odds, { path } = {}) {
  return parseWithSchema(odds, oddsSchema, { path });
}

function validateMeta(meta, { path } = {}) {
  if (!meta?.league?.id) throw new Error(`${path ? `${path}: ` : ''}league.id missing in meta`);
  return meta;
}

function validateFixtureResponse(res, { path } = {}) {
  return parseWithSchema(res, fixturesResponseSchema, { path });
}

module.exports = {
  parseWithSchema,
  validateFixture,
  validateOdds,
  validateMeta,
  validateWithSchema: parseWithSchema,
  validateFixtureResponse,
};
