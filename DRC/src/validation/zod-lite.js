class ParseError extends Error {
  constructor(issues) {
    super(issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; '));
    this.issues = issues;
  }
}

class Schema {
  constructor(parse, opts = {}) {
    this._parse = parse;
    this._type = opts.type || 'schema';
    this._optional = Boolean(opts.optional);
  }

  parse(value, path = []) {
    return this._parse(value, path);
  }

  safeParse(value) {
    try {
      const data = this.parse(value, []);
      return { success: true, data };
    } catch (err) {
      return { success: false, error: { issues: err.issues || [{ path: [], message: err.message }] } };
    }
  }

  optional() {
    return new Schema((value, path) => {
      if (value === undefined) return undefined;
      return this.parse(value, path);
    }, { type: this._type, optional: true });
  }

  nullable() {
    return new Schema((value, path) => {
      if (value === null) return null;
      return this.parse(value, path);
    }, { type: this._type });
  }

  transform(fn) {
    return new Schema((value, path) => fn(this.parse(value, path)), { type: this._type });
  }

  strict() {
    return this;
  }
}

function issue(path, message) {
  return new ParseError([{ path, message }]);
}

function string() {
  return new Schema((value, path) => {
    if (typeof value !== 'string') throw issue(path, 'Expected string');
    return value;
  }, { type: 'string' });
}

function number() {
  return new Schema((value, path) => {
    const n = Number(value);
    if (!Number.isFinite(n)) throw issue(path, 'Expected number');
    return n;
  }, { type: 'number' });
}

function any() {
  return new Schema((value) => value, { type: 'any' });
}

function union(schemas) {
  return new Schema((value, path) => {
    for (const s of schemas) {
      const res = s.safeParse(value);
      if (res.success) return res.data;
    }
    throw issue(path, 'No union match');
  });
}

function array(schema) {
  return new Schema((value, path) => {
    if (!Array.isArray(value)) throw issue(path, 'Expected array');
    return value.map((v, idx) => schema.parse(v, path.concat(idx)));
  }, { type: 'array' });
}

function record(schema) {
  return new Schema((value, path) => {
    if (typeof value !== 'object' || value === null) throw issue(path, 'Expected object');
    const out = {};
    Object.entries(value).forEach(([k, v]) => {
      out[k] = schema.parse(v, path.concat(k));
    });
    return out;
  });
}

function object(shape) {
  const parse = (value, path) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw issue(path, 'Expected object');
    const out = {};
    for (const [key, schema] of Object.entries(shape)) {
      const nextPath = path.concat(key);
      if (value[key] === undefined) {
        if (schema instanceof Schema && schema._optional) {
          out[key] = undefined;
          continue;
        }
        throw issue(nextPath, 'Required');
      }
      out[key] = schema.parse(value[key], nextPath);
    }
    return out;
  };
  const schema = new Schema(parse, { type: 'object' });
  schema.partial = () => object(Object.fromEntries(Object.entries(shape).map(([k, s]) => [k, s.optional()])));
  return schema;
}

const z = { string, number, any, union, array, record, object };

module.exports = { z, string, number, any, union, array, record, object };
