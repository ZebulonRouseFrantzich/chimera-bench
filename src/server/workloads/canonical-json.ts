/**
 * Deterministic JSON canonicalization utilities.
 *
 * Objects are serialized with lexicographically sorted keys so hashing
 * and provenance snapshots stay stable regardless of input key ordering.
 */

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value));
}

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | {
      [key: string]: CanonicalJsonValue;
    };

function normalizeCanonicalValue(value: unknown): CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => normalizeCanonicalValue(entry));
  }

  if (!isPlainRecord(value)) {
    throw new Error("Expected JSON-serializable canonicalization input.");
  }

  const normalized: {
    [key: string]: CanonicalJsonValue;
  } = {};

  for (const key of Object.keys(value).sort(compareLexicographic)) {
    normalized[key] = normalizeCanonicalValue(value[key]);
  }

  return normalized;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareLexicographic(left: string, right: string): number {
  if (left < right) {
    return -1;
  }

  if (left > right) {
    return 1;
  }

  return 0;
}
