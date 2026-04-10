import { splitCommandLine } from "./command-line.js";

export interface NormalizedFormatCommand {
  args: string[];
  commandLine: string;
}

const isEnvAssignmentToken = (token: string): boolean =>
  /^[A-Za-z_][A-Za-z0-9_]*=.*/.test(token);

const isPrettierExecutable = (token: string): boolean =>
  /(^|[\\/])prettier(?:\.(?:cmd|exe|js|cjs|mjs))?$/i.test(token);

const isPrettierWriteFlag = (token: string): boolean =>
  token === "-w" || token === "--write" || token.startsWith("--write=");

const hasCheckEnabled = (token: string): boolean =>
  token === "--check" || token === "--check=true";

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const normalizePrettierFormatScript = (
  script: string,
  relativePath: string,
): NormalizedFormatCommand | undefined => {
  let tokens: string[];

  try {
    tokens = splitCommandLine(script);
  } catch (error: unknown) {
    throw new Error(
      `${relativePath}: unable to parse the "format" script for prettier normalization: ${formatError(error)}`,
    );
  }

  const firstNonEnvIndex = tokens.findIndex(
    (token) => !isEnvAssignmentToken(token),
  );
  if (firstNonEnvIndex < 0) {
    throw new Error(
      `${relativePath}: invalid "format" script: "${script}". Expected a standalone prettier command.`,
    );
  }

  const executable = tokens[firstNonEnvIndex];
  const hasAnyPrettierToken = tokens.some((token) =>
    token.toLowerCase().includes("prettier"),
  );
  if (!hasAnyPrettierToken) {
    return undefined;
  }

  const args = tokens.slice(firstNonEnvIndex + 1);
  const rewriteNeeded =
    args.some(isPrettierWriteFlag) ||
    args.includes("--check=false") ||
    !args.some(hasCheckEnabled);

  if (!rewriteNeeded) {
    return undefined;
  }

  if (!isPrettierExecutable(executable)) {
    throw new Error(
      `${relativePath}: the "format" script must invoke prettier directly when check-mode enforcement is needed. ` +
        `Found: "${script}". Use a standalone prettier command (for example: "prettier --check .").`,
    );
  }

  if (firstNonEnvIndex > 0) {
    throw new Error(
      `${relativePath}: the "format" script cannot include inline environment assignments when prettier check-mode enforcement is needed. ` +
        `Found: "${script}". Move env vars to the workflow/job environment and use a standalone prettier command.`,
    );
  }

  const normalizedArgs = args.filter(
    (token) => token !== "--check=false" && !isPrettierWriteFlag(token),
  );
  if (!normalizedArgs.some(hasCheckEnabled)) {
    normalizedArgs.push("--check");
  }
  if (!normalizedArgs.some((token) => token.includes("CHANGELOG"))) {
    normalizedArgs.push("!**/CHANGELOG.md");
  }

  return {
    args: normalizedArgs,
    commandLine: "prettier",
  };
};
