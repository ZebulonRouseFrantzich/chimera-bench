export function sanitizeControlCharacters(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, " ");
}

export function sanitizeErrorCode(code: string, fallback: string): string {
  const normalized = code.toUpperCase().replace(/[^A-Z0-9_]/g, "_");
  return normalized.length > 0 ? normalized : fallback;
}
