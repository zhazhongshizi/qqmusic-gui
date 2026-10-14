const encoder = new TextEncoder();

/** Shared validation primitives; adapters retain their public error codes. */
export function createSchemaGuards(invalid: () => never) {
  function record(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) return invalid();
    const keys = Object.keys(value);
    if (required.some(key => !keys.includes(key))
      || keys.some(key => !required.includes(key) && !optional.includes(key))) return invalid();
    return value as Record<string, unknown>;
  }
  function exactRecord(value: unknown, keys: readonly string[]) { return record(value, keys); }
  function unsigned(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) return invalid();
    return value as number;
  }
  function utf8Text(value: unknown, maximum: number, allowEmpty = false): string {
    if (typeof value !== "string" || (!allowEmpty && !value.length)
      || encoder.encode(value).byteLength > maximum || /[\r\n\0]/.test(value)) return invalid();
    return value;
  }
  return { record, exactRecord, unsigned, utf8Text };
}
