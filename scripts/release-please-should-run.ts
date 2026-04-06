import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { resolveReleasePleaseMetadataOnlyPrChangedFiles } from "../src/helpers/release-please.js";

const execFileAsync = promisify(execFile);

const outputPath = process.env.GITHUB_OUTPUT;
const workingDirectory = process.env.GITHUB_WORKSPACE || process.cwd();

const setOutput = (name: string, value: string): void => {
  if (!outputPath) {
    return;
  }

  fs.appendFileSync(outputPath, `${name}=${value}\n`);
};

setOutput("skip", "false");

try {
  const changedFiles = await resolveReleasePleaseMetadataOnlyPrChangedFiles(
    workingDirectory,
    async (commandLine, args, cwd, options) => {
      const { stdout } = await execFileAsync(commandLine, args, {
        cwd,
        encoding: "utf8",
      });

      options?.stdout?.(Buffer.from(stdout));
    },
  );

  if (changedFiles) {
    console.log(
      `Skipping build-and-test for metadata-only Release Please PR: ${changedFiles.join(", ")}`,
    );
    setOutput("skip", "true");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `Unable to evaluate Release Please PR skip logic; defaulting to running build-and-test. ${message}`,
  );
  setOutput("skip", "false");
}
