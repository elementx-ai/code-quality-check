import path from "node:path";

import {
  ConfigViolation,
  MIN_DEPENDENCY_AGE_DAYS,
  ancestorChain,
  readFileIfExists,
} from "./config-files.js";

import { Project } from "../types.js";

const SECONDS_PER_DAY = 86400;
const MIN_COOLDOWN_SECONDS = MIN_DEPENDENCY_AGE_DAYS * SECONDS_PER_DAY;

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

const projectHasPythonTarget = (project: Project): boolean =>
  project.targets.some((target) => target.ecosystem === "python");

export const findPythonConfigViolations = async (
  projects: Project[],
  boundaryDirectory: string,
): Promise<ConfigViolation[]> => {
  const pythonProjects = projects.filter(projectHasPythonTarget);

  const violations = await Promise.all(
    pythonProjects.map(async (project) => {
      const reason = await validateUvCooldown(
        project.rootPath,
        boundaryDirectory,
      );
      return reason === undefined
        ? undefined
        : { reasons: [reason], relativePath: project.relativePath };
    }),
  );

  return violations.filter(
    (violation): violation is ConfigViolation => violation !== undefined,
  );
};
