export interface SweepValidationIssue {
  code: string;
  message: string;
  path: string;
}

export interface SweepValidationFailurePayload {
  code: "VALIDATION_SWEEP_EMPTY" | "VALIDATION_SWEEP_TOO_LARGE" | "VALIDATION_SWEEP_INVALID";
  message: string;
  details?: {
    issues: SweepValidationIssue[];
  };
}

export type SweepValidationResult =
  | {
      ok: true;
      plannedCases: number;
    }
  | {
      ok: false;
      payload: SweepValidationFailurePayload;
    };
