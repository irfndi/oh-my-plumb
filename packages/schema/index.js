// A root entry so a runtime that ignores "exports" can still resolve this
// package. Bun's standalone-executable loader resolves bare specifiers to
// <pkg>/index.js and never reads "exports", which is how the Pi extension's
// import of this package failed to resolve inside omp.
export * from "./dist/index.js";
