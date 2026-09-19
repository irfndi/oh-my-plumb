export const assertNever = (value: never, message = "Unhandled variant"): never => {
  throw new Error(`${message}: ${JSON.stringify(value)}`);
};
