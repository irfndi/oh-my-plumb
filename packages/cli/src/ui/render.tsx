import { render } from "ink";
import type { ReactElement, ReactNode } from "react";
import { Live, type Progress } from "./components/Live.js";
import { ErrorView } from "./views/ErrorView.js";

/**
 * Draws a finished view once and leaves. Ink prints the final frame on a pipe
 * too, so `oh-my-plumb report | less` still reads well. Nothing in the hooks goes
 * through here: their stdout belongs to the host.
 */
export const showStatic = async (element: ReactElement): Promise<void> => {
  const instance = render(element, { patchConsole: false, exitOnCtrlC: true });
  instance.unmount();
  await instance.waitUntilExit();
};

type LiveJob<T> = {
  header: ReactNode;
  run: (progress: Progress) => Promise<T>;
  done: (result: T) => ReactNode;
  /** Exit code once the result is drawn. */
  code?: (result: T) => number;
};

/** Runs a job under a spinner, draws its result, and resolves to the exit code. */
export const showLive = async <T,>(job: LiveJob<T>): Promise<number> => {
  const outcome: { code: number; result?: { value: T } } = { code: 0 };
  const instance = render(
    <Live<T>
      header={job.header}
      run={job.run}
      done={(result) => {
        outcome.result = { value: result };
        return job.done(result);
      }}
      failed={(error) => <ErrorView error={error} />}
      onExit={(exitCode) => {
        outcome.code = exitCode;
      }}
      animate={Boolean(process.stdout.isTTY)}
    />,
    { patchConsole: false, exitOnCtrlC: true },
  );
  await instance.waitUntilExit();
  if (outcome.result !== undefined && job.code) return job.code(outcome.result.value);
  return outcome.code;
};

export const showError = async (error: unknown): Promise<void> => {
  await showStatic(<ErrorView error={error} />);
};
