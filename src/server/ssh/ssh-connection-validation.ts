import { isIP } from "node:net";

export const SSH_USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;

const HOSTNAME_LABEL_PATTERN = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;

export function isValidSshHost(value: string): boolean {
  if (isIP(value) !== 0) {
    return true;
  }

  if (value.includes("..") || value.endsWith(".")) {
    return false;
  }

  const labels = value.split(".");
  if (labels.length === 0) {
    return false;
  }

  return labels.every((label) => HOSTNAME_LABEL_PATTERN.test(label));
}
