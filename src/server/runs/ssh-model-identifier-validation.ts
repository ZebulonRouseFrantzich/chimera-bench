import { posix as posixPath } from "node:path";
import { PATH_CONTROL_CHARACTER_PATTERN } from "../targets/target-profile.ts";

const MODEL_IDENTIFIER_PATH = "model.identifier";

export interface SshModelIdentifierValidationIssue {
  code: string;
  message: string;
  path: string;
}

export type SshModelIdentifierValidationResult =
  | {
      ok: true;
      normalizedIdentifier: string;
    }
  | {
      ok: false;
      issues: SshModelIdentifierValidationIssue[];
    };

export function validateSshModelIdentifier(
  rawIdentifier: string,
  remoteModelRoots: readonly string[],
): SshModelIdentifierValidationResult {
  const issues: SshModelIdentifierValidationIssue[] = [];

  if (PATH_CONTROL_CHARACTER_PATTERN.test(rawIdentifier)) {
    issues.push({
      code: "MODEL_IDENTIFIER_CONTROL_CHARACTERS",
      message: "model.identifier must not contain control characters.",
      path: MODEL_IDENTIFIER_PATH,
    });
  }

  if (!rawIdentifier.startsWith("/")) {
    issues.push({
      code: "MODEL_IDENTIFIER_NOT_ABSOLUTE",
      message: "model.identifier must start with '/'.",
      path: MODEL_IDENTIFIER_PATH,
    });
  }

  if (hasPathTraversalSegment(rawIdentifier)) {
    issues.push({
      code: "MODEL_IDENTIFIER_PATH_TRAVERSAL",
      message: "model.identifier must not include '..' path traversal segments.",
      path: MODEL_IDENTIFIER_PATH,
    });
  }

  const normalizedIdentifier = posixPath.normalize(rawIdentifier);

  if (!normalizedIdentifier.toLowerCase().endsWith(".gguf")) {
    issues.push({
      code: "MODEL_IDENTIFIER_EXTENSION_INVALID",
      message: "model.identifier must point to a .gguf file.",
      path: MODEL_IDENTIFIER_PATH,
    });
  }

  const normalizedRoots = remoteModelRoots.map(normalizeRemoteModelRoot);
  const matchesAtLeastOneRoot = normalizedRoots.some((root) => {
    return isWithinNormalizedRoot(normalizedIdentifier, root);
  });

  if (!matchesAtLeastOneRoot) {
    issues.push({
      code: "MODEL_IDENTIFIER_OUTSIDE_ALLOWED_ROOTS",
      message: "model.identifier is outside target profile remoteModelRoots.",
      path: MODEL_IDENTIFIER_PATH,
    });
  }

  if (issues.length > 0) {
    return {
      ok: false,
      issues,
    };
  }

  return {
    ok: true,
    normalizedIdentifier,
  };
}

export function normalizeRemoteModelRoot(rootPath: string): string {
  const normalizedRoot = posixPath.normalize(rootPath);
  if (normalizedRoot === "/") {
    return normalizedRoot;
  }

  return normalizedRoot.replace(/\/+$/, "");
}

export function isWithinNormalizedRoot(candidatePath: string, rootPath: string): boolean {
  if (rootPath === "/") {
    return candidatePath.startsWith("/");
  }

  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}/`);
}

function hasPathTraversalSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "..");
}
