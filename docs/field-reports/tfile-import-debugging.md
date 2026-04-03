# TFile Import Debugging — Field Report

**Date:** 2026-03-26
**Type:** investigation
**Project:** obsidi-mcp

## Goal

Track down why `create_note` was returning a "TFile undefined" error when called from external Claude Code sessions. The tool worked sometimes but failed unpredictably on certain paths, and the error provided almost no diagnostic context because the tool handler swallowed exceptions silently.

## Root Cause

The bug was a compile-time erasure of runtime-critical imports.

`obsidianTools.ts` line 1 read:

```typescript
import type { App, TFile, TFolder } from 'obsidian';
import { TAbstractFile } from 'obsidian';
```

TypeScript's `import type` is erased entirely during compilation. Since obsidi-mcp uses esbuild with `external: ["obsidian"]`, the `obsidian` module is resolved at runtime via `require("obsidian")`. But `import type` tells both TypeScript and esbuild to strip the binding — so `TFile` and `TFolder` never made it into the compiled output.

The compiled `main.js` showed the evidence clearly:

- `TAbstractFile` (value import) compiled to `import_obsidian.TAbstractFile` — correctly resolved
- `TFile` (type import) compiled to bare `TFile` — an undefined free variable

Every `instanceof TFile` check (14+ occurrences across the codebase) was actually `instanceof undefined`, which throws `TypeError: Right-hand side of instanceof is not callable`.

The reason it "worked sometimes" is still unclear — it may depend on Obsidian's module loader state, plugin load order, or whether another plugin happened to assign `TFile` to a reachable scope. The error was deterministic once it appeared, but the conditions for it appearing were timing-dependent.

## What We Tried

**Step 1: Read the error description.** The user's notes from the original session said "TFile undefined error." This pointed directly at a missing runtime reference rather than a null file object.

**Step 2: Trace the compiled output.** Grepped `main.js` (the 48k-line esbuild bundle) for `instanceof TFile` and found bare `TFile` references — not `import_obsidian.TFile`. Confirmed by checking that `import_obsidian = require("obsidian")` existed but `TFile` was never destructured from it.

**Step 3: Compare with working import.** `TAbstractFile` on line 2 was a value import and compiled correctly. The fix was obvious: move `TFile` and `TFolder` to the value import line.

No trial-and-error was needed. The root cause was identified from the compiled output before any code changes were made.

## Gotchas

**`import type` is invisible in source review.** The source code looks perfectly correct — `TFile` is imported, it's used in type annotations and instanceof checks, TypeScript doesn't complain. The bug only manifests in the compiled output. You have to read `main.js` or know the esbuild externals behavior to catch it.

**esbuild externals change the rules.** In a normal bundle, esbuild would tree-shake or inline the module. With `external: ["obsidian"]`, it emits a `require()` call. But `import type` is processed before esbuild sees it — TypeScript strips the binding, so esbuild never knows `TFile` was needed at runtime.

**Silent error swallowing hid the real error.** The `wrapHandler` pattern caught the TypeError and returned `{error: "..."}` JSON without logging anything server-side. The user saw a cryptic error in Claude Code with no corresponding log in Obsidian's dev console. This made the bug appear intermittent and path-dependent when it was actually a deterministic import failure.

## Recommendations

1. **Use value imports for any type used in runtime expressions.** `instanceof`, runtime type guards, and constructor calls all need the actual class at runtime. Reserve `import type` for types used only in annotations.

2. **Verify compiled output after adding instanceof checks.** A quick `grep "instanceof Foo" main.js` after building catches erased imports immediately.

3. **Log at the tool handler level, not just the transport level.** The MCP server logged tool calls, but the tool handlers themselves were silent on errors. Both layers need logging — the transport for request/response, the handler for operation details.

4. **Normalize LLM-generated paths at the boundary.** LLMs emit curly quotes, smart dashes, and other typographic characters in paths. Normalize these at the MCP tool parameter extraction point before they reach Obsidian APIs.

## Key Takeaways

- `import type` + esbuild `external` = erased runtime references. This is a class of bug that TypeScript's type checker cannot catch because it's correct at the type level.
- Always read the compiled bundle when debugging runtime errors in Obsidian plugins. The source lies about what's available at runtime.
- Silent error handling in tool handlers turns deterministic bugs into mysterious intermittent failures. Log errors where they happen, not just where they're caught.
- The fix was one line (changing `import type` to `import`). The diagnosis took 20 minutes of reading compiled output. Systematic tracing beats guessing.
