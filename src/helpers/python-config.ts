import path from "node:path";

import {
  CheckFinding,
  ConfigCheckResult,
  MIN_DEPENDENCY_AGE_DAYS,
  ancestorChain,
  collectFindings,
  fileExists,
  firstNonEmptyLine,
  readFileIfExists,
  readFileUpwards,
} from "./config-files.js";

import { Project } from "../types.js";

const SECONDS_PER_DAY = 86400;
const MIN_COOLDOWN_SECONDS = MIN_DEPENDENCY_AGE_DAYS * SECONDS_PER_DAY;

export const MIN_PYTHON_VERSION = "3.13";
export const RECOMMENDED_PYTHON_VERSION = "3.14";

const minPythonRank = 3 * 1000 + 13;
const recommendedPythonRank = 3 * 1000 + 14;

const pythonVersionPattern = /^(\d+)\.(\d+)(?:\.\d+)?$/;
const requiresPythonLowerBoundPattern = /(>=|~=|==|>)\s*(\d+)\.(\d+)/;

const versionRank = (major: number, minor: number): number =>
  major * 1000 + minor;

const classifyPythonVersion = (
  major: number,
  minor: number,
  subject: string,
): CheckFinding | undefined => {
  const rank = versionRank(major, minor);
  if (rank < minPythonRank) {
    return {
      severity: "error",
      reason: `${subject} but the minimum is ${MIN_PYTHON_VERSION}`,
    };
  }

  if (rank < recommendedPythonRank) {
    return {
      severity: "warning",
      reason: `${subject}; the recommended minimum is ${RECOMMENDED_PYTHON_VERSION}`,
    };
  }

  return undefined;
};

const unitSeconds: Record<string, number> = {
  s: 1,
  sec: 1,
  secs: 1,
  second: 1,
  seconds: 1,
  m: 60,
  min: 60,
  mins: 60,
  minute: 60,
  minutes: 60,
  h: 3600,
  hr: 3600,
  hrs: 3600,
  hour: 3600,
  hours: 3600,
  d: SECONDS_PER_DAY,
  day: SECONDS_PER_DAY,
  days: SECONDS_PER_DAY,
  w: 7 * SECONDS_PER_DAY,
  wk: 7 * SECONDS_PER_DAY,
  wks: 7 * SECONDS_PER_DAY,
  week: 7 * SECONDS_PER_DAY,
  weeks: 7 * SECONDS_PER_DAY,
  mo: 30 * SECONDS_PER_DAY,
  mos: 30 * SECONDS_PER_DAY,
  month: 30 * SECONDS_PER_DAY,
  months: 30 * SECONDS_PER_DAY,
  y: 365 * SECONDS_PER_DAY,
  yr: 365 * SECONDS_PER_DAY,
  yrs: 365 * SECONDS_PER_DAY,
  year: 365 * SECONDS_PER_DAY,
  years: 365 * SECONDS_PER_DAY,
};

const parseNumber = (value: string | undefined): number =>
  value === undefined ? 0 : Number.parseFloat(value);

const parseIsoDuration = (value: string): number | undefined => {
  const match =
    /^P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(
      value,
    );
  if (!match) {
    return undefined;
  }

  const [, years, months, weeks, days, hours, minutes, seconds] = match;
  if (
    [years, months, weeks, days, hours, minutes, seconds].every(
      (part) => part === undefined,
    )
  ) {
    return undefined;
  }

  return (
    parseNumber(years) * unitSeconds.year +
    parseNumber(months) * unitSeconds.mo +
    parseNumber(weeks) * unitSeconds.week +
    parseNumber(days) * unitSeconds.day +
    parseNumber(hours) * unitSeconds.hour +
    parseNumber(minutes) * unitSeconds.minute +
    parseNumber(seconds)
  );
};

const friendlyTokenPattern = /(\d+(?:\.\d+)?)\s*([a-zµ]+)/gi;

const parseFriendlyDuration = (value: string): number | undefined => {
  const matches = [...value.matchAll(friendlyTokenPattern)];
  if (matches.length === 0) {
    return undefined;
  }

  const remainder = value.replace(friendlyTokenPattern, "").replace(/\s+/g, "");
  if (remainder.length > 0) {
    return undefined;
  }

  const factors = matches.map((match) => {
    const factor = unitSeconds[match[2].toLowerCase()];
    return factor === undefined
      ? undefined
      : Number.parseFloat(match[1]) * factor;
  });
  if (factors.some((factor) => factor === undefined)) {
    return undefined;
  }

  return factors.reduce<number>((sum, factor) => sum + (factor ?? 0), 0);
};

const durationToSeconds = (value: string): number | undefined =>
  /^P/i.test(value) ? parseIsoDuration(value) : parseFriendlyDuration(value);

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const tableBody = (
  content: string,
  table: string | null,
): string | undefined => {
  const lines = content.split(/\r?\n/);
  const isHeader = (line: string): boolean => /^\s*\[/.test(line);

  if (table === null) {
    const headerIndex = lines.findIndex(isHeader);
    return lines
      .slice(0, headerIndex === -1 ? lines.length : headerIndex)
      .join("\n");
  }

  const headerPattern = new RegExp(
    `^\\s*\\[${escapeRegExp(table)}\\]\\s*(#.*)?$`,
  );
  const startIndex = lines.findIndex((line) => headerPattern.test(line));
  if (startIndex === -1) {
    return undefined;
  }

  const afterHeader = lines.slice(startIndex + 1);
  const nextHeaderIndex = afterHeader.findIndex(isHeader);
  return afterHeader
    .slice(0, nextHeaderIndex === -1 ? afterHeader.length : nextHeaderIndex)
    .join("\n");
};

const excludeNewerPattern =
  /^\s*exclude-newer\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m;

const readExcludeNewer = (body: string | undefined): string | undefined => {
  if (body === undefined) {
    return undefined;
  }

  const match = excludeNewerPattern.exec(body);
  if (!match) {
    return undefined;
  }

  return (match[1] ?? match[2] ?? match[3])?.trim();
};

interface ResolvedSetting {
  relativePath: string;
  value: string;
}

const resolveExcludeNewer = async (
  rootPath: string,
  boundaryDirectory: string,
): Promise<ResolvedSetting | undefined> => {
  const directories = ancestorChain(rootPath, boundaryDirectory);

  for (const directory of directories) {
    const uvToml = await readFileIfExists(path.join(directory, "uv.toml"));
    const fromUvToml =
      uvToml === undefined
        ? undefined
        : readExcludeNewer(tableBody(uvToml, null));
    if (fromUvToml !== undefined) {
      return {
        relativePath:
          path.relative(boundaryDirectory, path.join(directory, "uv.toml")) ||
          "uv.toml",
        value: fromUvToml,
      };
    }

    const pyproject = await readFileIfExists(
      path.join(directory, "pyproject.toml"),
    );
    const fromPyproject =
      pyproject === undefined
        ? undefined
        : readExcludeNewer(tableBody(pyproject, "tool.uv"));
    if (fromPyproject !== undefined) {
      return {
        relativePath:
          path.relative(
            boundaryDirectory,
            path.join(directory, "pyproject.toml"),
          ) || "pyproject.toml",
        value: fromPyproject,
      };
    }
  }

  return undefined;
};

const validateUvCooldown = async (
  rootPath: string,
  boundaryDirectory: string,
): Promise<string | undefined> => {
  const resolved = await resolveExcludeNewer(rootPath, boundaryDirectory);
  if (!resolved) {
    return `missing a uv dependency cooldown: set "exclude-newer" to at least "${MIN_DEPENDENCY_AGE_DAYS} days" under [tool.uv] in pyproject.toml or in uv.toml`;
  }

  if (/^\d{4}-\d{2}-\d{2}/.test(resolved.value)) {
    return `${resolved.relativePath} sets "exclude-newer" to a fixed date ("${resolved.value}"); use a duration such as "${MIN_DEPENDENCY_AGE_DAYS} days" for a rolling cooldown`;
  }

  const seconds = durationToSeconds(resolved.value);
  if (seconds === undefined) {
    return `${resolved.relativePath} has an unparseable "exclude-newer" duration: "${resolved.value}"`;
  }

  if (seconds < MIN_COOLDOWN_SECONDS) {
    return `${resolved.relativePath} sets "exclude-newer=${resolved.value}" but the minimum cooldown is ${MIN_DEPENDENCY_AGE_DAYS} days`;
  }

  return undefined;
};

const minReleaseAgePattern =
  /^\s*min-release-age\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m;

const readMinReleaseAge = (body: string | undefined): string | undefined => {
  if (body === undefined) {
    return undefined;
  }

  const match = minReleaseAgePattern.exec(body);
  if (!match) {
    return undefined;
  }

  return (match[1] ?? match[2] ?? match[3])?.trim();
};

const resolveMinReleaseAge = async (
  rootPath: string,
  boundaryDirectory: string,
): Promise<ResolvedSetting | undefined> => {
  const directories = ancestorChain(rootPath, boundaryDirectory);

  for (const directory of directories) {
    const poetryToml = await readFileIfExists(
      path.join(directory, "poetry.toml"),
    );
    const fromPoetryToml =
      poetryToml === undefined
        ? undefined
        : readMinReleaseAge(tableBody(poetryToml, "solver"));
    if (fromPoetryToml !== undefined) {
      return {
        relativePath:
          path.relative(
            boundaryDirectory,
            path.join(directory, "poetry.toml"),
          ) || "poetry.toml",
        value: fromPoetryToml,
      };
    }
  }

  return undefined;
};

const validatePoetryCooldown = async (
  rootPath: string,
  boundaryDirectory: string,
): Promise<string | undefined> => {
  const resolved = await resolveMinReleaseAge(rootPath, boundaryDirectory);
  if (!resolved) {
    return `missing a poetry dependency cooldown: set "min-release-age" to at least ${MIN_DEPENDENCY_AGE_DAYS} under [solver] in poetry.toml (poetry config --local solver.min-release-age ${MIN_DEPENDENCY_AGE_DAYS})`;
  }

  if (!/^\d+$/.test(resolved.value)) {
    return `${resolved.relativePath} has an invalid "min-release-age": "${resolved.value}"; set an integer number of days`;
  }

  const days = Number.parseInt(resolved.value, 10);
  if (days < MIN_DEPENDENCY_AGE_DAYS) {
    return `${resolved.relativePath} sets "min-release-age=${resolved.value}" but the minimum cooldown is ${MIN_DEPENDENCY_AGE_DAYS} days`;
  }

  return undefined;
};

const hasTable = (content: string, table: string): boolean =>
  tableBody(content, table) !== undefined;

const buildBackendPattern =
  /^\s*build-backend\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m;

const usesPoetryBuildBackend = (pyproject: string): boolean => {
  const buildSystem = tableBody(pyproject, "build-system");
  if (buildSystem === undefined) {
    return false;
  }

  const match = buildBackendPattern.exec(buildSystem);
  const backend = (match?.[1] ?? match?.[2] ?? match?.[3])?.trim();
  return backend === "poetry.core.masonry.api";
};

type PackageManager = "uv" | "poetry";

const detectPackageManagers = async (
  rootPath: string,
  boundaryDirectory: string,
): Promise<Set<PackageManager>> => {
  const directories = ancestorChain(rootPath, boundaryDirectory);
  const managers = new Set<PackageManager>();

  for (const directory of directories) {
    const pyproject = await readFileIfExists(
      path.join(directory, "pyproject.toml"),
    );
    if (pyproject !== undefined) {
      if (hasTable(pyproject, "tool.uv")) {
        managers.add("uv");
      }
      if (
        hasTable(pyproject, "tool.poetry") ||
        usesPoetryBuildBackend(pyproject)
      ) {
        managers.add("poetry");
      }
    }

    const sidecars: Array<[string, PackageManager]> = [
      ["uv.toml", "uv"],
      ["uv.lock", "uv"],
      ["poetry.toml", "poetry"],
      ["poetry.lock", "poetry"],
    ];
    for (const [fileName, manager] of sidecars) {
      if (await fileExists(path.join(directory, fileName))) {
        managers.add(manager);
      }
    }
  }

  return managers;
};

const validateCooldown = async (
  rootPath: string,
  boundaryDirectory: string,
): Promise<string | undefined> => {
  const managers = await detectPackageManagers(rootPath, boundaryDirectory);

  if (managers.has("poetry") && !managers.has("uv")) {
    return validatePoetryCooldown(rootPath, boundaryDirectory);
  }

  if (managers.has("poetry") && managers.has("uv")) {
    const uvReason = await validateUvCooldown(rootPath, boundaryDirectory);
    if (uvReason === undefined) {
      return undefined;
    }
    const poetryReason = await validatePoetryCooldown(
      rootPath,
      boundaryDirectory,
    );
    return poetryReason === undefined ? undefined : uvReason;
  }

  return validateUvCooldown(rootPath, boundaryDirectory);
};

const validatePythonVersionFile = async (
  rootPath: string,
  boundaryDirectory: string,
): Promise<CheckFinding | undefined> => {
  const resolved = await readFileUpwards(
    rootPath,
    boundaryDirectory,
    ".python-version",
  );
  if (!resolved) {
    return {
      severity: "error",
      reason: `missing a .python-version file pinning the Python version to at least ${MIN_PYTHON_VERSION} (for example "${RECOMMENDED_PYTHON_VERSION}")`,
    };
  }

  const version = firstNonEmptyLine(resolved.content);
  const match = pythonVersionPattern.exec(version);
  if (!match) {
    return {
      severity: "error",
      reason: `${resolved.relativePath} must pin a numeric Python version of at least ${MIN_PYTHON_VERSION} (aliases such as "pypy3.10" are not allowed), found: "${version || "<empty>"}"`,
    };
  }

  return classifyPythonVersion(
    Number.parseInt(match[1], 10),
    Number.parseInt(match[2], 10),
    `${resolved.relativePath} pins Python ${version}`,
  );
};

const requiresPythonPattern =
  /^\s*requires-python\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/m;

const readRequiresPython = (body: string | undefined): string | undefined => {
  if (body === undefined) {
    return undefined;
  }

  const match = requiresPythonPattern.exec(body);
  if (!match) {
    return undefined;
  }

  return (match[1] ?? match[2] ?? match[3])?.trim();
};

const validateRequiresPython = async (
  rootPath: string,
  boundaryDirectory: string,
): Promise<CheckFinding | undefined> => {
  const directories = ancestorChain(rootPath, boundaryDirectory);

  for (const directory of directories) {
    const pyproject = await readFileIfExists(
      path.join(directory, "pyproject.toml"),
    );
    if (pyproject === undefined) {
      continue;
    }

    const value = readRequiresPython(tableBody(pyproject, "project"));
    if (value === undefined) {
      continue;
    }

    const relativePath =
      path.relative(
        boundaryDirectory,
        path.join(directory, "pyproject.toml"),
      ) || "pyproject.toml";
    const match = requiresPythonLowerBoundPattern.exec(value);
    if (!match) {
      return {
        severity: "error",
        reason: `${relativePath} has an unparseable "requires-python": "${value}"`,
      };
    }

    return classifyPythonVersion(
      Number.parseInt(match[2], 10),
      Number.parseInt(match[3], 10),
      `${relativePath} sets requires-python "${value}"`,
    );
  }

  return undefined;
};

const projectHasPythonTarget = (project: Project): boolean =>
  project.targets.some((target) => target.ecosystem === "python");

export const findPythonConfigViolations = async (
  projects: Project[],
  boundaryDirectory: string,
): Promise<ConfigCheckResult> => {
  const pythonProjects = projects.filter(projectHasPythonTarget);

  const entries = await Promise.all(
    pythonProjects.map(async (project) => {
      const [cooldownReason, versionFileFinding, requiresPythonFinding] =
        await Promise.all([
          validateCooldown(project.rootPath, boundaryDirectory),
          validatePythonVersionFile(project.rootPath, boundaryDirectory),
          validateRequiresPython(project.rootPath, boundaryDirectory),
        ]);

      const findings = [
        cooldownReason === undefined
          ? undefined
          : ({ severity: "error", reason: cooldownReason } as CheckFinding),
        versionFileFinding,
        requiresPythonFinding,
      ].filter((finding): finding is CheckFinding => finding !== undefined);

      return { relativePath: project.relativePath, findings };
    }),
  );

  return collectFindings(entries);
};
