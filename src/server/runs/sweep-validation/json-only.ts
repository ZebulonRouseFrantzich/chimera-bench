/**
 * JSON-only sweep value validator with bounded traversal.
 *
 * This module rejects non-JSON types and circular references while also
 * enforcing the same depth/node budgets used for request-param validation.
 */
import {
  MAX_REQUEST_PARAM_DEPTH,
  MAX_REQUEST_PARAM_NODES,
} from "../../api/schemas.ts";
import { createSweepIssue } from "./issue-utils.ts";
import type { SweepValidationIssue } from "./types.ts";

export function validateJsonOnlyValue(input: {
  value: unknown;
  path: string;
  issues: SweepValidationIssue[];
  seenObjects: Set<object>;
  depth: number;
  state: {
    nodes: number;
    exceededNodeBudget: boolean;
  };
}): void {
  const { depth, issues, path, seenObjects, state, value } = input;

  if (state.exceededNodeBudget) {
    return;
  }

  if (depth > MAX_REQUEST_PARAM_DEPTH) {
    issues.push(
      createSweepIssue({
        code: "VALIDATION_SWEEP_INVALID",
        message: `Sweep values nested depth exceeds ${MAX_REQUEST_PARAM_DEPTH}.`,
        path,
      }),
    );
    return;
  }

  state.nodes += 1;
  if (state.nodes > MAX_REQUEST_PARAM_NODES) {
    state.exceededNodeBudget = true;
    issues.push(
      createSweepIssue({
        code: "VALIDATION_SWEEP_INVALID",
        message: `Sweep values exceed node budget of ${MAX_REQUEST_PARAM_NODES}.`,
        path,
      }),
    );
    return;
  }

  if (value === null) {
    return;
  }

  switch (typeof value) {
    case "boolean":
    case "string":
      return;
    case "number":
      if (Number.isFinite(value)) {
        return;
      }

      issues.push(
        createSweepIssue({
          code: "VALIDATION_SWEEP_INVALID",
          message: "Sweep values must not contain non-finite numbers.",
          path,
        }),
      );
      return;
    case "undefined":
      issues.push(
        createSweepIssue({
          code: "VALIDATION_SWEEP_INVALID",
          message: "Sweep values must not contain undefined.",
          path,
        }),
      );
      return;
    case "bigint":
      issues.push(
        createSweepIssue({
          code: "VALIDATION_SWEEP_INVALID",
          message: "Sweep values must not contain BigInt values.",
          path,
        }),
      );
      return;
    case "symbol":
      issues.push(
        createSweepIssue({
          code: "VALIDATION_SWEEP_INVALID",
          message: "Sweep values must not contain symbols.",
          path,
        }),
      );
      return;
    case "function":
      issues.push(
        createSweepIssue({
          code: "VALIDATION_SWEEP_INVALID",
          message: "Sweep values must not contain functions.",
          path,
        }),
      );
      return;
    default:
      break;
  }

  if (Array.isArray(value)) {
    if (seenObjects.has(value)) {
      issues.push(
        createSweepIssue({
          code: "VALIDATION_SWEEP_INVALID",
          message: "Sweep values must not contain circular references.",
          path,
        }),
      );
      return;
    }

    seenObjects.add(value);
    for (let index = 0; index < value.length; index += 1) {
      validateJsonOnlyValue({
        value: value[index],
        path: `${path}[${index}]`,
        issues,
        seenObjects,
        depth: depth + 1,
        state,
      });
    }
    seenObjects.delete(value);
    return;
  }

  if (!isPlainJsonObject(value)) {
    issues.push(
      createSweepIssue({
        code: "VALIDATION_SWEEP_INVALID",
        message: "Sweep values must be JSON-compatible plain objects.",
        path,
      }),
    );
    return;
  }

  if (seenObjects.has(value)) {
    issues.push(
      createSweepIssue({
        code: "VALIDATION_SWEEP_INVALID",
        message: "Sweep values must not contain circular references.",
        path,
      }),
    );
    return;
  }

  seenObjects.add(value);
  for (const [key, nestedValue] of Object.entries(value)) {
    validateJsonOnlyValue({
      value: nestedValue,
      path: path.length > 0 ? `${path}.${key}` : key,
      issues,
      seenObjects,
      depth: depth + 1,
      state,
    });
  }
  seenObjects.delete(value);
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
