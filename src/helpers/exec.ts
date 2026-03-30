import * as exec from "@actions/exec";

export interface ExecOptions {
  rewrapExitCode?: boolean;
  silent?: boolean;
  stdout?: (data: Buffer) => void;
}

export const execCommand = async (
  commandLine: string,
  args: string[],
  cwd: string,
  options?: ExecOptions,
): Promise<void> => {
  const result = await exec.exec(commandLine, args, {
    cwd,
    ignoreReturnCode: options?.rewrapExitCode ?? false,
    listeners: options?.stdout
      ? {
          stdout: options.stdout,
        }
      : undefined,
    silent: options?.silent ?? false,
  });

  if (options?.rewrapExitCode && result !== 0) {
    throw new Error(
      `Command failed with exit code ${result}: ${[commandLine, ...args].join(" ")}`,
    );
  }
};
