import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { describe, expect, it } from "vite-plus/test";
import { probeKey, type ProbeTarget } from "../src/lib/keyProbe.js";

const typesafe = { kind: "typesafe", key: "k", from: "the environment" } as const;
const gateway = { kind: "gateway", key: "g", from: "the environment" } as const;

type Seen = { authorization: string | undefined; method: string | undefined };

/** A real HTTP answer, because what the probe reads is a status on the wire. */
const serving = async (
  status: number,
  run: (target: ProbeTarget, seen: () => Seen) => Promise<void>,
): Promise<void> => {
  const seen: Seen = { authorization: undefined, method: undefined };
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    seen.authorization = request.headers.authorization;
    seen.method = request.method;
    response.writeHead(status, { "content-type": "application/json" });
    response.end('{"detail":{"message":"no"}}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    await run(
      {
        url: `http://127.0.0.1:${address.port}/systemone`,
        name: "api.typesafe.ai",
        method: "POST",
      },
      () => seen,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

describe("probeKey", () => {
  it("reads a 401 as the key being refused, and sends the key", async () => {
    await serving(401, async (target, seen) => {
      expect(await probeKey(typesafe, target)).toEqual({
        kind: "rejected",
        message: "api.typesafe.ai refused the key (401)",
      });
      expect(seen().authorization).toBe("Bearer k");
      expect(seen().method).toBe("POST");
    });
  });

  it("reads a 403 the same way", async () => {
    await serving(403, async (target) => {
      expect((await probeKey(typesafe, target)).kind).toBe("rejected");
    });
  });

  it("probes the gateway with a GET, the request its auth answers", async () => {
    await serving(401, async (target, seen) => {
      const probe = await probeKey(gateway, { ...target, name: "the AI gateway", method: "GET" });
      expect(probe).toEqual({
        kind: "rejected",
        message: "the AI gateway refused the key (401)",
      });
      expect(seen().method).toBe("GET");
      expect(seen().authorization).toBe("Bearer g");
    });
  });

  it("does not blame the key for a provider outage", async () => {
    await serving(503, async (target) => {
      expect((await probeKey(typesafe, target)).kind).toBe("accepted");
    });
  });

  it("says nothing when the provider cannot be reached at all", async () => {
    const target = {
      url: "http://127.0.0.1:1/systemone",
      name: "api.typesafe.ai",
      method: "POST",
    } as const;
    expect((await probeKey(typesafe, target)).kind).toBe("unknown");
  });
});
