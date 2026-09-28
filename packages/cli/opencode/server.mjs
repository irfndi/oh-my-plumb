// Entry point for hosts that load oh-my-plumb as a package plugin: OpenCode v2
// resolves the `server` export and older loaders fall back to package main.
// The plugins directory is the package root here, so this re-exports the real
// v2 module next to it.
export { default } from "./oh-my-plumb-v2.js";
