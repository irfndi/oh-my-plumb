import { GATEWAY_PROBE_URL, KEY_PROBE_TIMEOUT_MS, TYPESAFE_PROBE_URL } from "./constants.js";
import type { Credentials } from "./credentials.js";

export type KeyProbe =
  | { kind: "accepted" }
  | { kind: "rejected"; message: string }
  | { kind: "unknown" };

export type ProbeTarget = { url: string; name: string; method: "GET" | "POST" };

const targetOf = (creds: Exclude<Credentials, { kind: "none" }>): ProbeTarget =>
  creds.kind === "typesafe"
    ? { url: TYPESAFE_PROBE_URL, name: "api.typesafe.ai", method: "POST" }
    : { url: GATEWAY_PROBE_URL, name: "the AI gateway", method: "GET" };

/**
 * One request, no tokens spent: only the answer's status decides, and only an
 * auth refusal is read as a bad key. A provider outage or a moved route says
 * nothing about the credential and must never be reported as one.
 */
export const probeKey = async (
  creds: Exclude<Credentials, { kind: "none" }>,
  target: ProbeTarget = targetOf(creds),
): Promise<KeyProbe> => {
  try {
    const response = await fetch(target.url, {
      method: target.method,
      headers: { authorization: `Bearer ${creds.key}`, "content-type": "application/json" },
      ...(target.method === "POST" ? { body: "{}" } : {}),
      signal: AbortSignal.timeout(KEY_PROBE_TIMEOUT_MS),
    });
    return response.status === 401 || response.status === 403
      ? { kind: "rejected", message: `${target.name} refused the key (${response.status})` }
      : { kind: "accepted" };
  } catch {
    return { kind: "unknown" };
  }
};
