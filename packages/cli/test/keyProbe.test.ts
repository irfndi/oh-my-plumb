import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { probeKey, type ProbeTarget } from "../src/lib/keyProbe.js";

const creds = { kind: "typesafe", key: "k", from: "the environment" } as const;

/** A real HTTP answer, because what the probe reads is a status on the wire. */
const serving = async (
  status: number,
  run: (target: ProbeTarget, sentAuth: () => string | undefined) => Promise<void>,
): Promise<void> => {
  let authorization: string | undefined;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    authorization = request.headers.authorization;
    response.writeHead(status, { "content-type": "application/json" });
    response.end('{"detail":{"message":"no"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    await run(
      { url: `http://127.0.0.1:${address.port}/systemone`, name: "api.typesafe.ai" },
      () => authorization,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

describe("probeKey", () => {
  it("reads a 401 as the key being refused, and sends the key", async () => {
    await serving(401, async (target, sentAuth) => {
      expect(await probeKey(creds, target)).toEqual({
        kind: "rejected",
        message: "api.typesafe.ai refused the key (401)",
      });
      expect(sentAuth()).toBe("Bearer k");
    });
  });

  it("reads a 403 the same way", async () => {
    await serving(403, async (target) => {
      expect((await probeKey(creds, target)).kind).toBe("rejected");
    });
  });

  it("does not blame the key for a provider outage", async () => {
    await serving(503, async (target) => {
      expect((await probeKey(creds, target)).kind).toBe("accepted");
    });
  });

  it("says nothing when the provider cannot be reached at all", async () => {
    const target = { url: "http://127.0.0.1:1/systemone", name: "api.typesafe.ai" };
    expect((await probeKey(creds, target)).kind).toBe("unknown");
  });
});
