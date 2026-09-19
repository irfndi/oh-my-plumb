import { Box, Text, useApp } from "ink";
import Spinner from "ink-spinner";
import { useEffect, useState, type ReactNode } from "react";
import { palette } from "../theme.js";

export type Progress = (label: string) => void;

type LiveProps<T> = {
  /** Shown above the spinner while `run` is going. */
  header: ReactNode;
  run: (progress: Progress) => Promise<T>;
  done: (result: T) => ReactNode;
  failed: (error: unknown) => ReactNode;
  onExit?: (code: number) => void;
  /** Redraw the progress line. Off on a pipe, where every frame would be printed as a new line. */
  animate?: boolean;
};

type State<T> =
  | { kind: "running"; label: string }
  | { kind: "done"; result: T }
  | { kind: "failed"; error: unknown };

/** Runs a job and draws its progress, then its result, then leaves. */
export function Live<T>({ header, run, done, failed, onExit, animate = true }: LiveProps<T>) {
  const { exit } = useApp();
  const [state, setState] = useState<State<T>>({ kind: "running", label: "starting" });
  useEffect(() => {
    let alive = true;
    run((label) => {
      if (alive && animate) setState({ kind: "running", label });
    })
      .then((result) => {
        if (alive) setState({ kind: "done", result });
      })
      .catch((error: unknown) => {
        if (alive) setState({ kind: "failed", error });
      });
    return () => {
      alive = false;
    };
    // The job runs once for the life of the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Leave only after the final frame has been drawn, not in the same tick it was asked for.
  useEffect(() => {
    if (state.kind === "running") return;
    onExit?.(state.kind === "done" ? 0 : 1);
    exit();
  }, [state.kind, exit, onExit]);
  // The result view draws its own header, so the wrapper shows one only while there is nothing else to show.
  return (
    <Box flexDirection="column">
      {state.kind === "running" ? header : null}
      {state.kind === "running" ? (
        animate ? (
          <Box>
            <Text color={palette.teal}>
              <Spinner type="dots" />
            </Text>
            <Text color={palette.mist}> {state.label}</Text>
          </Box>
        ) : (
          <Text color={palette.mist}>working</Text>
        )
      ) : state.kind === "done" ? (
        done(state.result)
      ) : (
        failed(state.error)
      )}
    </Box>
  );
}
