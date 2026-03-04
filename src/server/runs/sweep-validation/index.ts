/**
 * Sweep config validation and planned-case accounting for POST /runs.
 *
 * This module validates sweep axes, computes planned cases without full matrix
 * expansion, and returns stable API errors for oversized/unsafe configurations.
 */
import {
  MAX_SWEEP_CASES,
  type NormalizedSweepConfig,
  RequestParamsSchema,
} from "../../api/schemas.ts";
import {
  DENYLISTED_SERVER_FLAGS,
  RESERVED_REQUEST_PARAM_KEYS,
  RESERVED_SERVER_FLAGS,
} from "../../engines/starter-engine/constants.ts";
import { extractFlagToken } from "../../engines/starter-engine/utils.ts";
import { formatValidationIssues } from "../../http/validation-issues.ts";
import { createSweepIssue } from "./issue-utils.ts";
import { validateJsonOnlyValue } from "./json-only.ts";
import type {
  SweepValidationIssue,
  SweepValidationResult,
} from "./types.ts";

export function validateAndPlanSweepConfig(
  sweep: NormalizedSweepConfig,
): SweepValidationResult {
  const issues: SweepValidationIssue[] = [];

  if (!Number.isInteger(sweep.maxCases) || sweep.maxCases < 1) {
    issues.push(
      createSweepIssue({
        code: "VALIDATION_SWEEP_INVALID",
        message: "sweep.maxCases must be an integer >= 1.",
        path: "sweep.maxCases",
      }),
    );
  }

  if (Number.isInteger(sweep.maxCases) && sweep.maxCases > MAX_SWEEP_CASES) {
    return {
      ok: false,
      payload: {
        code: "VALIDATION_SWEEP_TOO_LARGE",
        message: `sweep.maxCases must be <= ${MAX_SWEEP_CASES}.`,
      },
    };
  }

  if (!Number.isInteger(sweep.repetitions) || sweep.repetitions < 1) {
    issues.push(
      createSweepIssue({
        code: "VALIDATION_SWEEP_INVALID",
        message: "sweep.repetitions must be an integer >= 1.",
        path: "sweep.repetitions",
      }),
    );
  }

  const serverArgsAxes = Object.entries(sweep.axes.serverArgs);
  const requestParamsAxes = Object.entries(sweep.axes.requestParams);
  if (serverArgsAxes.length === 0 && requestParamsAxes.length === 0) {
    return {
      ok: false,
      payload: {
        code: "VALIDATION_SWEEP_EMPTY",
        message:
          "sweep.axes must include at least one axis in serverArgs or requestParams.",
      },
    };
  }

  const axisLengths: number[] = [];

  for (const [axisKey, fragments] of serverArgsAxes) {
    axisLengths.push(fragments.length);

    if (fragments.length === 0) {
      issues.push(
        createSweepIssue({
          code: "VALIDATION_SWEEP_INVALID",
          message: "Each sweep.axes.serverArgs axis must include at least one argv fragment.",
          path: `sweep.axes.serverArgs.${axisKey}`,
        }),
      );
      continue;
    }

    for (let fragmentIndex = 0; fragmentIndex < fragments.length; fragmentIndex += 1) {
      const fragment = fragments[fragmentIndex];
      const fragmentPath = `sweep.axes.serverArgs.${axisKey}[${fragmentIndex}]`;
      if (!Array.isArray(fragment) || fragment.length === 0) {
        issues.push(
          createSweepIssue({
            code: "VALIDATION_SWEEP_INVALID",
            message:
              "Each sweep.axes.serverArgs fragment must be a non-empty argv string array.",
            path: fragmentPath,
          }),
        );
        continue;
      }

      for (let tokenIndex = 0; tokenIndex < fragment.length; tokenIndex += 1) {
        const token = fragment[tokenIndex];
        if (typeof token !== "string" || token.length === 0) {
          issues.push(
            createSweepIssue({
              code: "VALIDATION_SWEEP_INVALID",
              message: "Sweep serverArgs tokens must be non-empty strings.",
              path: `${fragmentPath}[${tokenIndex}]`,
            }),
          );
          continue;
        }

        validateSweepServerArgToken({
          token,
          path: `${fragmentPath}[${tokenIndex}]`,
          issues,
        });
      }
    }
  }

  for (const [requestParamKey, values] of requestParamsAxes) {
    axisLengths.push(values.length);

    if (values.length === 0) {
      issues.push(
        createSweepIssue({
          code: "VALIDATION_SWEEP_INVALID",
          message:
            "Each sweep.axes.requestParams axis must include at least one candidate value.",
          path: `sweep.axes.requestParams.${requestParamKey}`,
        }),
      );
      continue;
    }

    if (RESERVED_REQUEST_PARAM_KEYS.has(requestParamKey)) {
      issues.push(
        createSweepIssue({
          code: "REQUEST_PARAM_RESERVED",
          message: `requestParams.${requestParamKey} is reserved and owned by the orchestrator.`,
          path: `sweep.axes.requestParams.${requestParamKey}`,
        }),
      );
    }

    for (let valueIndex = 0; valueIndex < values.length; valueIndex += 1) {
      const value = values[valueIndex];
      const valuePath = `sweep.axes.requestParams.${requestParamKey}[${valueIndex}]`;

      const issueCountBeforeValueValidation = issues.length;
      validateJsonOnlyValue({
        value,
        path: valuePath,
        issues,
        seenObjects: new Set<object>(),
        depth: 0,
        state: {
          nodes: 0,
          exceededNodeBudget: false,
        },
      });
      if (issues.length > issueCountBeforeValueValidation) {
        continue;
      }

      const budgetValidation = RequestParamsSchema.safeParse({
        [requestParamKey]: value,
      });
      if (!budgetValidation.success) {
        const budgetIssues = formatValidationIssues(budgetValidation.error.issues);
        for (const budgetIssue of budgetIssues) {
          issues.push(
            createSweepIssue({
              code: "REQUEST_PARAM_VALUE_INVALID",
              message: budgetIssue.message,
              path: buildSweepRequestValuePath(
                requestParamKey,
                valueIndex,
                budgetIssue.path,
              ),
            }),
          );
        }
      }
    }
  }

  if (issues.length > 0) {
    return {
      ok: false,
      payload: {
        code: "VALIDATION_SWEEP_INVALID",
        message: "Sweep configuration is invalid.",
        details: {
          issues,
        },
      },
    };
  }

  const plannedCases = computePlannedCases({
    axisLengths,
    repetitions: sweep.repetitions,
    maxAllowedCases: Math.min(sweep.maxCases, MAX_SWEEP_CASES),
  });
  if (plannedCases > sweep.maxCases || plannedCases > MAX_SWEEP_CASES) {
    return {
      ok: false,
      payload: {
        code: "VALIDATION_SWEEP_TOO_LARGE",
        message:
          `Sweep expands to at least ${plannedCases} cases, which exceeds maxCases=${sweep.maxCases} ` +
          `or the server ceiling of ${MAX_SWEEP_CASES}.`,
      },
    };
  }

  return {
    ok: true,
    plannedCases,
  };
}

export function computeMaxSweepAdditionalServerArgs(
  sweep: NormalizedSweepConfig,
): number {
  let maxAdditionalArgs = 0;

  for (const fragments of Object.values(sweep.axes.serverArgs)) {
    let axisLongestFragment = 0;
    for (const fragment of fragments) {
      axisLongestFragment = Math.max(axisLongestFragment, fragment.length);
    }

    maxAdditionalArgs += axisLongestFragment;
  }

  return maxAdditionalArgs;
}

function validateSweepServerArgToken(input: {
  token: string;
  path: string;
  issues: SweepValidationIssue[];
}): void {
  const { issues, path, token } = input;
  if (!token.startsWith("-") || /^-(?:\d|\.\d)/.test(token)) {
    return;
  }

  const rawFlag = extractFlagToken(token);
  const normalizedFlag = rawFlag.toLowerCase();
  if (RESERVED_SERVER_FLAGS.has(normalizedFlag)) {
    issues.push(
      createSweepIssue({
        code: "SERVER_ARG_RESERVED",
        message: `Argument '${rawFlag}' is reserved and owned by the orchestrator.`,
        path,
      }),
    );
    return;
  }

  if (DENYLISTED_SERVER_FLAGS.has(normalizedFlag)) {
    issues.push(
      createSweepIssue({
        code: "SERVER_ARG_DENYLISTED",
        message: `Argument '${rawFlag}' is denied by the current safety policy.`,
        path,
      }),
    );
  }
}

function buildSweepRequestValuePath(
  requestParamKey: string,
  valueIndex: number,
  zodPath: string,
): string {
  const basePath = `sweep.axes.requestParams.${requestParamKey}[${valueIndex}]`;
  if (zodPath === "(root)" || zodPath === requestParamKey) {
    return basePath;
  }

  if (zodPath.startsWith(`${requestParamKey}.`) || zodPath.startsWith(`${requestParamKey}[`)) {
    return `${basePath}${zodPath.slice(requestParamKey.length)}`;
  }

  return basePath;
}

function computePlannedCases(input: {
  axisLengths: readonly number[];
  repetitions: number;
  maxAllowedCases: number;
}): number {
  const { axisLengths, maxAllowedCases, repetitions } = input;
  if (repetitions > maxAllowedCases) {
    return maxAllowedCases + 1;
  }

  let plannedCases = repetitions;

  for (const axisLength of axisLengths) {
    if (plannedCases > maxAllowedCases) {
      return maxAllowedCases + 1;
    }

    const maxAxisLengthForBudget = Math.floor(maxAllowedCases / plannedCases);
    if (axisLength > maxAxisLengthForBudget) {
      return maxAllowedCases + 1;
    }

    plannedCases *= axisLength;
  }

  return plannedCases;
}
