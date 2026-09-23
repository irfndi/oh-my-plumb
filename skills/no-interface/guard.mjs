#!/usr/bin/env node
// Contract: file text on stdin, FILE_PATH in env, one JSON line on stdout, exit 0 either way.

let text = "";
for await (const chunk of process.stdin) text += chunk;

const isTypeScript = /\.(ts|tsx|mts|cts)$/.test(process.env.FILE_PATH ?? "");
const hits = [];
if (isTypeScript) {
  text.split("\n").forEach((line, index) => {
    if (/^\s*(export\s+)?(declare\s+)?interface\s+[A-Za-z_$]/.test(line)) {
      hits.push(`line ${index + 1}: ${line.trim().slice(0, 120)}`);
    }
  });
}

console.log(
  hits.length === 0
    ? JSON.stringify({ isError: false })
    : JSON.stringify({ isError: true, content: `Use type, not interface.\n${hits.join("\n")}` }),
);
