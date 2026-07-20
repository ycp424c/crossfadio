export type PromptProjectionOptions = {
  /** Object keys that survive the optional-field pruning pass. */
  requiredKeys?: readonly string[];
  /** String fields that must not be cropped. A minimal JSON fallback is used if they cannot fit. */
  protectedStringKeys?: readonly string[];
  maxDepth?: number;
};

/**
 * Projects structured prompt data into a complete JSON document.
 *
 * Reduction order is deliberate: low-priority array tails, optional object
 * fields, and only then string contents. Serialized JSON is never sliced.
 */
export function projectPromptJson(
  value: unknown,
  maxChars: number,
  options: PromptProjectionOptions = {}
): string {
  if (!Number.isInteger(maxChars) || maxChars <= 0) {
    throw new RangeError('Prompt JSON budget must be a positive integer');
  }

  let projected = sanitizeJsonValue(value, options.maxDepth ?? 32);
  let serialized = JSON.stringify(projected);
  if (serialized.length <= maxChars) return serialized;

  serialized = pruneArrayTails(projected, maxChars);
  if (serialized.length <= maxChars) return serialized;

  serialized = pruneOptionalFields(
    projected,
    maxChars,
    new Set(options.requiredKeys ?? [])
  );
  if (serialized.length <= maxChars) return serialized;

  const cropped = cropStrings(
    projected,
    maxChars,
    new Set(options.protectedStringKeys ?? [])
  );
  projected = cropped.value;
  serialized = cropped.serialized;
  if (serialized.length <= maxChars) return serialized;

  // A one-character scalar is the shortest valid JSON document. Reaching
  // this branch means the caller's protected structure cannot fit.
  if (maxChars === 1) return '0';
  if (Array.isArray(projected)) return '[]';
  if (projected !== null && typeof projected === 'object') return '{}';
  return '0';
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

function sanitizeJsonValue(value: unknown, maxDepth: number): JsonValue {
  const ancestors = new WeakSet<object>();

  function visit(input: unknown, depth: number): JsonValue {
    if (input === null) return null;
    if (typeof input === 'string' || typeof input === 'boolean') return input;
    if (typeof input === 'number') return Number.isFinite(input) ? input : null;
    if (typeof input === 'bigint') return String(input);
    if (typeof input !== 'object' || depth >= maxDepth) return null;
    if (ancestors.has(input)) return null;

    ancestors.add(input);
    let result: JsonValue;
    if (Array.isArray(input)) {
      result = input.map((item) => visit(item, depth + 1));
    } else {
      const object: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(input)) {
        if (typeof child === 'undefined' || typeof child === 'function' || typeof child === 'symbol') continue;
        object[key] = visit(child, depth + 1);
      }
      result = object;
    }
    ancestors.delete(input);
    return result;
  }

  return visit(value, 0);
}

function pruneArrayTails(value: JsonValue, maxChars: number): string {
  const arrays = collectArrays(value);
  let serialized = JSON.stringify(value);
  while (serialized.length > maxChars) {
    const array = arrays
      .filter((candidate) => candidate.length > 0)
      .sort((left, right) => right.length - left.length)[0];
    if (!array) break;
    array.pop();
    serialized = JSON.stringify(value);
  }
  return serialized;
}

function collectArrays(value: JsonValue): JsonValue[][] {
  const arrays: JsonValue[][] = [];
  function visit(input: JsonValue): void {
    if (Array.isArray(input)) {
      arrays.push(input);
      for (const item of input) visit(item);
      return;
    }
    if (input !== null && typeof input === 'object') {
      for (const child of Object.values(input)) visit(child);
    }
  }
  visit(value);
  return arrays;
}

function pruneOptionalFields(value: JsonValue, maxChars: number, requiredKeys: Set<string>): string {
  const fields: Array<{ parent: Record<string, JsonValue>; key: string; size: number }> = [];
  function visit(input: JsonValue): void {
    if (Array.isArray(input)) {
      for (const item of input) visit(item);
      return;
    }
    if (input === null || typeof input !== 'object') return;
    for (const [key, child] of Object.entries(input)) {
      if (!requiredKeys.has(key)) {
        fields.push({ parent: input, key, size: JSON.stringify(child).length + key.length });
      }
      visit(child);
    }
  }
  visit(value);
  fields.sort((left, right) => right.size - left.size || left.key.localeCompare(right.key));

  let serialized = JSON.stringify(value);
  for (const field of fields) {
    if (serialized.length <= maxChars) break;
    if (!(field.key in field.parent)) continue;
    delete field.parent[field.key];
    serialized = JSON.stringify(value);
  }
  return serialized;
}

function cropStrings(
  value: JsonValue,
  maxChars: number,
  protectedKeys: Set<string>
): { value: JsonValue; serialized: string } {
  const root = { value };
  type StringRef = {
    key: string;
    get(): string;
    set(next: string): void;
  };
  const refs: StringRef[] = [];

  function visit(input: JsonValue, parent: JsonValue[] | Record<string, JsonValue> | typeof root, key: string | number): void {
    if (typeof input === 'string') {
      const stringKey = String(key);
      refs.push({
        key: stringKey,
        get: () => parent[key as never] as string,
        set: (next) => { parent[key as never] = next as never; }
      });
      return;
    }
    if (Array.isArray(input)) {
      input.forEach((item, index) => visit(item, input, index));
      return;
    }
    if (input !== null && typeof input === 'object') {
      for (const [childKey, child] of Object.entries(input)) visit(child, input, childKey);
    }
  }
  visit(value, root, 'value');

  let serialized = JSON.stringify(root.value);
  while (serialized.length > maxChars) {
    const candidates = refs
      .filter((ref) => !protectedKeys.has(ref.key) && ref.get().length > 0)
      .sort((left, right) => JSON.stringify(right.get()).length - JSON.stringify(left.get()).length);
    const target = candidates[0];
    if (!target) break;
    const characters = Array.from(target.get());
    const overflow = serialized.length - maxChars;
    const removeCount = Math.max(1, Math.min(characters.length, Math.ceil(overflow / 2)));
    target.set(characters.slice(0, characters.length - removeCount).join(''));
    serialized = JSON.stringify(root.value);
  }
  return { value: root.value, serialized };
}
