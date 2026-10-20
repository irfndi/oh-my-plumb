import { describe, expect, it } from "vite-plus/test";
import { describeModelFailure } from "../src/lib/jev.js";

const typesafe = { kind: "typesafe", key: "k", from: "the environment" } as const;
const gateway = { kind: "gateway", key: "g", from: "~/.oh-my-plumb/.env" } as const;

const answered = (statusCode: number, responseBody: string): Error =>
  Object.assign(new Error("request failed"), { statusCode, responseBody });

describe("describeModelFailure", () => {
  it("names Jev itself and reads a 401 as the key being refused", () => {
    const failure = describeModelFailure(
      answered(
        401,
        '{"detail":{"error_type":"authentication_error","message":"Cannot authenticate with the server. Please check your API key and try again."}}',
      ),
      typesafe,
    );
    expect(failure.code).toBe("AUTH_FAILED");
    expect(failure.message).toBe(
      "api.typesafe.ai refused the key (401): Cannot authenticate with the server. Please check your API key and try again.",
    );
  });

  it("names the AI gateway when that is the one holding the key", () => {
    const failure = describeModelFailure(answered(429, '{"message":"Rate limited"}'), gateway);
    expect(failure.code).toBe("CHECK_FAILED");
    expect(failure.message).toBe("the AI gateway answered 429: Rate limited");
  });

  it("keeps a timeout a timeout, and says which endpoint went quiet", () => {
    const failure = describeModelFailure(
      Object.assign(new Error("Delay was aborted"), { name: "TimeoutError" }),
      typesafe,
    );
    expect(failure.code).toBe("CHECK_TIMEOUT");
    expect(failure.message).toBe("api.typesafe.ai did not answer within the time allowed");
  });

  it("passes an error with no answer through as its own message", () => {
    expect(describeModelFailure(new Error("socket hang up"), gateway).message).toBe(
      "socket hang up",
    );
  });
});
