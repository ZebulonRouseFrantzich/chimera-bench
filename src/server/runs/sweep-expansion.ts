/**
 * Deterministic sweep expansion and stable case identity helpers.
 *
 * Sweep axes expand in a stable order so run-case execution and persisted
 * artifacts remain reproducible across runs and refactors.
 */
import { createHash } from "node:crypto";
import {
  MAX_SWEEP_CASES,
  type NormalizedSweepConfig,
} from "../api/schemas.ts";

type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | CanonicalJsonValue[]
  | {
      [key: string]: CanonicalJsonValue;
    };

const SWEEP_CASE_CONFIG_ID_PREFIX = "sweep_";
const ROOT_PATH = "caseConfig";
const SWEEP_PATH = "sweep";

export class SweepCaseCanonicalizationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = "SweepCaseCanonicalizationError";
  }
}

export interface SweepExpansionWorkloadCase {
  promptId: string;
  prompt: string;
}

export interface ExpandedSweepCase {
  caseConfigId: string;
  caseId: string;
  /** Zero-based; caseId repetition suffixes are one-based (`.rep-1`, `.rep-2`, ...). */
  repetitionIndex: number;
  promptId: string;
  prompt: string;
  engineArgs: string[];
  requestParams: Record<string, unknown>;
}

export interface BuildSweepCaseConfigIdInput {
  engineId: string;
  modelIdentifier: string;
  workloadId: string;
  promptId: string;
  engineArgs: readonly string[];
  requestParams: Record<string, unknown>;
}

export function buildSweepCaseConfigId(input: BuildSweepCaseConfigIdInput): string {
  const canonicalPayload = normalizeCanonicalJsonValue(
    {
      engineId: input.engineId,
      modelIdentifier: input.modelIdentifier,
      workloadId: input.workloadId,
      promptId: input.promptId,
      engineArgs: [...input.engineArgs],
      requestParams: cloneJsonRecord(input.requestParams),
    },
    ROOT_PATH,
    new Set<object>(),
  );
  const canonicalJson = JSON.stringify(canonicalPayload);

  // `caseConfigId` intentionally omits runId so identical configurations map to
  // identical identities. Persisted artifacts remain run-scoped under
  // `runs/<runId>/result.json`, so this does not create cross-run path clashes.
  return `${SWEEP_CASE_CONFIG_ID_PREFIX}${createHash("sha256").update(canonicalJson).digest("hex")}`;
}

export function expandSweepCases(input: {
  engineId: string;
  modelIdentifier: string;
  workloadId: string;
  workloadCase: SweepExpansionWorkloadCase;
  baseServerArgs: readonly string[];
  baseRequestParams: Record<string, unknown>;
  sweep: NormalizedSweepConfig;
}): ExpandedSweepCase[] {
  const serverAxisKeys = Object.keys(input.sweep.axes.serverArgs).sort(compareLexicographic);
  const requestParamAxisKeys = Object.keys(input.sweep.axes.requestParams).sort(
    compareLexicographic,
  );

  const axisOrder = [
    ...serverAxisKeys.map((axisKey) => ({
      namespace: "serverArgs" as const,
      axisKey,
    })),
    ...requestParamAxisKeys.map((axisKey) => ({
      namespace: "requestParams" as const,
      axisKey,
    })),
  ];

  const expandedCases: ExpandedSweepCase[] = [];
  const selectedServerArgs = new Map<string, string[]>();
  const selectedRequestParams = new Map<string, unknown>();

  const emitCasesForCurrentSelection = (): void => {
    const engineArgs = [...input.baseServerArgs];
    for (const axisKey of serverAxisKeys) {
      const fragment = selectedServerArgs.get(axisKey);
      if (!fragment) {
        continue;
      }

      engineArgs.push(...fragment);
    }

    const requestParams = cloneJsonRecord(input.baseRequestParams);
    for (const axisKey of requestParamAxisKeys) {
      if (!selectedRequestParams.has(axisKey)) {
        continue;
      }

      requestParams[axisKey] = cloneJsonValue(selectedRequestParams.get(axisKey));
    }

    const caseConfigId = buildSweepCaseConfigId({
      engineId: input.engineId,
      modelIdentifier: input.modelIdentifier,
      workloadId: input.workloadId,
      promptId: input.workloadCase.promptId,
      engineArgs,
      requestParams,
    });

    for (let repetitionIndex = 0; repetitionIndex < input.sweep.repetitions; repetitionIndex += 1) {
      if (expandedCases.length >= MAX_SWEEP_CASES) {
        throw new SweepCaseCanonicalizationError(
          SWEEP_PATH,
          `Sweep expansion exceeded server case ceiling (${MAX_SWEEP_CASES})`,
        );
      }

      expandedCases.push({
        caseConfigId,
        caseId: `${caseConfigId}.rep-${repetitionIndex + 1}`,
        repetitionIndex,
        promptId: input.workloadCase.promptId,
        prompt: input.workloadCase.prompt,
        engineArgs: [...engineArgs],
        requestParams: cloneJsonRecord(requestParams),
      });
    }
  };

  const walkAxes = (axisIndex: number): void => {
    if (axisIndex >= axisOrder.length) {
      emitCasesForCurrentSelection();
      return;
    }

    const axis = axisOrder[axisIndex];
    if (!axis) {
      emitCasesForCurrentSelection();
      return;
    }

    if (axis.namespace === "serverArgs") {
      const fragments = input.sweep.axes.serverArgs[axis.axisKey] ?? [];
      for (const fragment of fragments) {
        selectedServerArgs.set(axis.axisKey, [...fragment]);
        walkAxes(axisIndex + 1);
      }

      selectedServerArgs.delete(axis.axisKey);
      return;
    }

    const values = input.sweep.axes.requestParams[axis.axisKey] ?? [];
    for (const value of values) {
      selectedRequestParams.set(axis.axisKey, value);
      walkAxes(axisIndex + 1);
    }

    selectedRequestParams.delete(axis.axisKey);
  };

  walkAxes(0);

  return expandedCases;
}

function normalizeCanonicalJsonValue(
  value: unknown,
  path: string,
  seenObjects: Set<object>,
): CanonicalJsonValue {
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number": {
      if (!Number.isFinite(value)) {
        throw new SweepCaseCanonicalizationError(
          path,
          "Sweep case config must not contain non-finite numbers",
        );
      }

      return value;
    }
    case "undefined":
      throw new SweepCaseCanonicalizationError(
        path,
        "Sweep case config must not contain undefined values",
      );
    case "bigint":
      throw new SweepCaseCanonicalizationError(
        path,
        "Sweep case config must not contain BigInt values",
      );
    case "symbol":
      throw new SweepCaseCanonicalizationError(
        path,
        "Sweep case config must not contain symbols",
      );
    case "function":
      throw new SweepCaseCanonicalizationError(
        path,
        "Sweep case config must not contain functions",
      );
    default:
      break;
  }

  if (Array.isArray(value)) {
    if (seenObjects.has(value)) {
      throw new SweepCaseCanonicalizationError(
        path,
        "Sweep case config must not contain circular references",
      );
    }

    seenObjects.add(value);
    const normalizedArray: CanonicalJsonValue[] = [];
    for (let index = 0; index < value.length; index += 1) {
      normalizedArray.push(
        normalizeCanonicalJsonValue(value[index], `${path}[${index}]`, seenObjects),
      );
    }
    seenObjects.delete(value);

    return normalizedArray;
  }

  if (!isPlainJsonObject(value)) {
    throw new SweepCaseCanonicalizationError(
      path,
      "Sweep case config must contain only plain JSON objects",
    );
  }

  if (seenObjects.has(value)) {
    throw new SweepCaseCanonicalizationError(
      path,
      "Sweep case config must not contain circular references",
    );
  }

  seenObjects.add(value);
  const normalizedObject: {
    [key: string]: CanonicalJsonValue;
  } = {};
  const keys = Object.keys(value).sort(compareLexicographic);
  for (const key of keys) {
    normalizedObject[key] = normalizeCanonicalJsonValue(
      value[key],
      `${path}.${key}`,
      seenObjects,
    );
  }
  seenObjects.delete(value);

  return normalizedObject;
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
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

function cloneJsonRecord(value: Record<string, unknown>): Record<string, unknown> {
  const cloned = cloneJsonValue(value);
  if (!isPlainJsonObject(cloned)) {
    throw new SweepCaseCanonicalizationError(
      ROOT_PATH,
      "Sweep request params must be a plain JSON object",
    );
  }

  return cloned;
}

function cloneJsonValue<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    throw new SweepCaseCanonicalizationError(
      ROOT_PATH,
      "Sweep case config could not be cloned safely",
    );
  }
}
