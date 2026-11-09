// A small JSON Schema 2020-12 validator for the keywords the shipped contracts use, so tests can check
// examples and recorded responses against the published schemas without a dependency.
const typeOf = value => value === null ? 'null' : Array.isArray(value) ? 'array'
  : typeof value === 'number' ? (Number.isInteger(value) ? 'integer' : 'number') : typeof value;
const typeMatches = (value, type) => typeOf(value) === type || (type === 'number' && typeOf(value) === 'integer');
const IGNORED = new Set(['description', 'summary', 'format', 'default', 'examples', 'example', 'contentMediaType', 'title', 'deprecated', 'readOnly', 'writeOnly', '$comment', 'bearerFormat', 'discriminator']);
const KNOWN = new Set(['$ref', 'type', 'enum', 'const', 'properties', 'required', 'additionalProperties', 'items', 'minItems', 'maxItems',
  'uniqueItems', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'minLength', 'maxLength', 'pattern', 'allOf', 'anyOf',
  'oneOf', 'not', 'if', 'then', 'else', 'maxProperties', 'minProperties', 'propertyNames', 'dependentRequired']);

export function createValidator(spec) {
  const resolve = ref => ref.slice(2).split('/').map(s => s.replaceAll('~1', '/').replaceAll('~0', '~')).reduce((v, k) => {
    if (!v || !Object.hasOwn(v, k)) throw new Error(`Missing ${ref}`);
    return v[k];
  }, spec);
  const errors = (schema, value, path) => {
    if (schema === true || schema === undefined) return [];
    if (schema === false) return [`${path}: not allowed`];
    for (const key of Object.keys(schema))
      if (!KNOWN.has(key) && !IGNORED.has(key) && !key.startsWith('x-')) throw new Error(`Unsupported schema keyword ${key} at ${path}`);
    const out = [];
    if (schema.$ref) out.push(...errors(resolve(schema.$ref), value, path));
    if (schema.type !== undefined && ![schema.type].flat().some(type => typeMatches(value, type))) return [...out, `${path}: expected ${schema.type}, got ${typeOf(value)}`];
    if (schema.enum && !schema.enum.some(item => JSON.stringify(item) === JSON.stringify(value))) out.push(`${path}: ${JSON.stringify(value)} not in enum`);
    if (Object.hasOwn(schema, 'const') && JSON.stringify(schema.const) !== JSON.stringify(value)) out.push(`${path}: expected const ${JSON.stringify(schema.const)}`);
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) out.push(`${path}: below minimum`);
      if (schema.maximum !== undefined && value > schema.maximum) out.push(`${path}: above maximum`);
      if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) out.push(`${path}: not above exclusiveMinimum`);
      if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) out.push(`${path}: not below exclusiveMaximum`);
    }
    if (typeof value === 'string') {
      const length = [...value].length;
      if (schema.minLength !== undefined && length < schema.minLength) out.push(`${path}: too short`);
      if (schema.maxLength !== undefined && length > schema.maxLength) out.push(`${path}: too long`);
      if (schema.pattern !== undefined && !new RegExp(schema.pattern, 'u').test(value)) out.push(`${path}: does not match ${schema.pattern}`);
    }
    if (Array.isArray(value)) {
      if (schema.minItems !== undefined && value.length < schema.minItems) out.push(`${path}: too few items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) out.push(`${path}: too many items`);
      if (schema.uniqueItems && new Set(value.map(v => JSON.stringify(v))).size !== value.length) out.push(`${path}: duplicate items`);
      if (schema.items !== undefined) value.forEach((item, i) => out.push(...errors(schema.items, item, `${path}[${i}]`)));
    }
    if (typeOf(value) === 'object') {
      const keys = Object.keys(value);
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) out.push(`${path}: missing ${key}`);
      if (schema.maxProperties !== undefined && keys.length > schema.maxProperties) out.push(`${path}: too many properties`);
      if (schema.minProperties !== undefined && keys.length < schema.minProperties) out.push(`${path}: too few properties`);
      for (const [key, needs] of Object.entries(schema.dependentRequired ?? {}))
        if (Object.hasOwn(value, key)) for (const need of needs) if (!Object.hasOwn(value, need)) out.push(`${path}: ${key} requires ${need}`);
      for (const key of keys) {
        if (schema.propertyNames) out.push(...errors(schema.propertyNames, key, `${path}{${key}}`));
        if (schema.properties && Object.hasOwn(schema.properties, key)) out.push(...errors(schema.properties[key], value[key], `${path}.${key}`));
        else if (schema.additionalProperties !== undefined) out.push(...errors(schema.additionalProperties, value[key], `${path}.${key}`));
      }
    }
    for (const sub of schema.allOf ?? []) out.push(...errors(sub, value, path));
    if (schema.anyOf && !schema.anyOf.some(sub => !errors(sub, value, path).length)) out.push(`${path}: matches no anyOf branch`);
    if (schema.oneOf && schema.oneOf.filter(sub => !errors(sub, value, path).length).length !== 1) out.push(`${path}: does not match exactly one oneOf branch`);
    if (schema.not && !errors(schema.not, value, path).length) out.push(`${path}: matches a forbidden schema`);
    if (schema.if !== undefined) {
      const branch = errors(schema.if, value, path).length ? schema.else : schema.then;
      if (branch !== undefined) out.push(...errors(branch, value, path));
    }
    return out;
  };
  return {
    errors: (schema, value) => errors(typeof schema === 'string' ? { $ref: `#/components/schemas/${schema}` } : schema, value, '$'),
    resolve,
  };
}
