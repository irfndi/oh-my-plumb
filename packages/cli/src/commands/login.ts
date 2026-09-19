import { parseArgs } from "node:util";
import { PlumbError } from "oh-my-plumb-schema";
import { GATEWAY_KEY_ENV, TYPESAFE_KEY_ENV } from "../lib/constants.js";
import { saveUserKey } from "../lib/credentials.js";
import { Callout } from "../ui/components/Callout.js";
import { showStatic } from "../ui/render.js";

/** Reads one line without echoing it, so the key never lands in a terminal scrollback. */
const readSecret = (prompt: string): Promise<string> =>
  new Promise((resolve) => {
    const stdin = process.stdin;
    process.stderr.write(prompt);
    const wasRaw = stdin.isTTY ? stdin.isRaw : false;
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let value = "";
    const done = (): void => {
      stdin.off("data", onData);
      if (stdin.isTTY) stdin.setRawMode(wasRaw);
      stdin.pause();
      process.stderr.write("\n");
      resolve(value.trim());
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          done();
          process.exit(1);
        }
        if (ch === "\n" || ch === "\r" || ch === "\u0004") {
          done();
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          value = value.slice(0, -1);
          continue;
        }
        value += ch;
      }
    };
    stdin.on("data", onData);
  });

/** Never a flag: a flag lands in shell history and CI logs. */
export const runLogin = async (argv: string[]): Promise<number> => {
  const { values } = parseArgs({
    args: argv,
    options: { gateway: { type: "boolean", default: false } },
  });
  const name = values.gateway ? GATEWAY_KEY_ENV : TYPESAFE_KEY_ENV;
  const key = await readSecret(
    values.gateway ? "Vercel AI Gateway key: " : "TypeSafe API key (from typesafe.ai): ",
  );
  if (key === "") throw new PlumbError("NO_API_KEY", "nothing was entered");
  const file = saveUserKey(name, key);
  await showStatic(
    Callout({
      tone: "ok",
      title: `${name} saved to ${file} (owner-only). Run oh-my-plumb init next.`,
    }),
  );
  return 0;
};
