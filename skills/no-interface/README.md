# no-interface

A guard for the repo rule "Use `type`, not `interface`."

`guard.mjs` reads the new contents of the edited file from stdin, finds `interface` declarations in TypeScript files, and prints one JSON line: `{"isError": false}` for a clean file, or `{"isError": true, "content": "..."}` naming the lines to fix. `FILE_PATH` tells it which file it got. It exits 0 either way, which is what the hook expects.

Point a rubric rule at it:

```json
{
  "check": {
    "type": "guard",
    "skill": "no-interface",
    "scope": "{*.ts,*.tsx}",
    "text": "Use type, not interface."
  }
}
```

Run it by hand against any file:

```
FILE_PATH=src/example.ts ./guard.mjs < src/example.ts
```

The match is a line-based regular expression, so the word `interface` in a comment or a string can block too; tighten the regular expression if it does. A guard that stops running altogether (bad syntax, no `node` on the PATH) is a silent pass: the hook skips it and the edit goes through.
