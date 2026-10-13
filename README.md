# dsh-turbo

Agent speed pack for DeepSeek Harness. Cuts model round-trips — the dominant
wall-clock cost of an agent step — for every session in the profile.

## What it adds

| Piece | What it does |
|---|---|
| `read_many` tool | Reads many UTF-8 files in ONE call. Every `paths` entry may be an exact path or a glob (`*`, `**`, `?`). Replaces serial glob → read → read chains. Files are read in parallel through the composed `ctx.fs` seam (sandbox + observation policy intact), with per-file line caps and a total character budget. |
| `workspace_map` tool | Renders the workspace (or a subdirectory) as an indented tree with file sizes in ONE call. First move in an unfamiliar repo instead of glob/list loops. Skips `node_modules`, `.git`, etc. unless `include_heavy: true`. |
| `turbo_parallel_subagents` tool | Splits a complex task into independent subtasks and prepares a parallel execution plan. The caller runs each planned `subagent` in parallel (DSH executes independent tool calls concurrently), then merges the outputs with `turbo_combine_results`. |
| `turbo_combine_results` tool | Merges the text outputs of parallel subagents into a single coherent response. Used after `turbo_parallel_subagents`. |
| `turbo:speed` prompt section | Standing system-prompt guidance (order 1550) teaching the model to batch independent calls into one turn and to reach for `read_many` / `workspace_map` first. Hidden automatically when the tools are restricted away. |
| ⚡ Turbo button (web) | A pill toggle in the composer tool row (`conversation.input.right`, right before the send action). It flips the plugin's **volatile** `enabled` Config field through the settings controller (`remote.settings`); the loader commits volatile edits in place (no fiber restart) and the host plugin mounts/unmounts the tools and the prompt section on `loader/volatile-update`. The same toggle also shows up on the Settings page as the plugin's config form. |

## Layout

```
package.json      — main lib/index.js, exports["./client"], dsh.bundle +
                    dsh.client manifests, dep @deepseek-ai/schemastery (Config schema)
cordis.patch.yml  — bundle patch: inserts the { id: turbo, name: dsh-turbo } loader row
lib/index.js     — host plugin: exports { name, inject, meta, Config, apply };
                    Config.enabled is a volatile field (read via .get()); apply()
                    mounts/unmounts registrations on loader/volatile-update
lib/client.js     — web half in the lazy-CJS window.__ModuleLoader__ format:
                    registers the Turbo toggle into conversation.input.right
LICENSE           — MIT license
.gitignore        — node_modules, logs, OS files
```

No build step. Tool definitions are hand-built against the raw
`ToolDefinition` contract (JSON Schema in the enforced DSH subset:
`type`/`properties`/`required` **arrays**/`additionalProperties`/`items`/`enum`
/`const`/`oneOf` + annotations; `required` as a per-property boolean is the
`defineTool` DSL form and is **rejected** by `tools.register`). The Config
schema is real `@deepseek-ai/schemastery` with a `.volatile()` field — the
settings service surfaces only volatile fields in its live form, and the
loader applies their edits in place. Non-volatile fields are invisible to
`remote.settings.describe()`.

## Install (already done for the `desktop` profile)

The package is a proper bundle, wired exactly like `dsh-locale-ru`:

1. `C:\Users\xzdes\.dsh\profiles\desktop\package.json`:
   - `dependencies`: `"dsh-turbo": "link:S:/dsh-turbo"`
   - `dsh.profile.bundles`: contains `"dsh-turbo"`
2. `pnpm install` in the profile dir registered the link in `pnpm-lock.yaml`
   and linked `node_modules\dsh-turbo` → `S:\dsh-turbo`.
3. `pnpm add @deepseek-ai/schemastery` **inside `S:\dsh-turbo`** installed the
   Config-schema dependency into the package's own `node_modules` (pnpm does
   not install dependencies of `link:` packages).
4. The bundle's own `cordis.patch.yml` contributes the loader row; the
   profile's `cordis.patch.yml` needs no turbo rows of its own.

It appears on the Plugins page as "Agent speed pack", can be toggled and
removed there, and survives pnpm/plugin-manager operations.

## Editing the plugin — restart is required

Verified experimentally on DSH 0.2.0-rc.2: **host-side code changes are NOT
picked up live.** The profile's package resolution is frozen at boot and
Node's ESM cache holds imported URLs; disable/enable cycles and bundle
toggles only restart the fiber with the already-imported module (the loader
re-imports a specifier only when it creates an entry for the first time).
Renaming the entry file does not help for the same reason — the frozen
resolution still points at the old `main`.

After editing host code (`lib/*.js`, `package.json`, `cordis.patch.yml`):

1. Fully quit DeepSeek Harness (tray included) and start it again.
2. Verify: `cordis_inspect_query` → Config `listConfigs` for
   `include:turbo` shows `status: "schema"`, and Tool `listTools` lists
   `read_many` / `workspace_map`.

The **client half** (`lib/client.js`) is fetched by the browser from the
host at page load; after a host restart, a page refresh of the Web GUI picks
up client edits.

BOM warning: never write `cordis.patch.yml` / profile `package.json` with a
UTF-8 BOM (Windows PowerShell 5.1 `Set-Content -Encoding utf8` adds one) —
the profile parsers reject it and the reload silently keeps the old tree.

## Verification

- Plugins page shows **Agent speed pack** as an installed, enabled bundle.
- `plugin_manager list_bundles` → `dsh-turbo` with row `turbo` →
  `include:turbo`; `list_plugins` → `include:turbo`, `fiberPhase: "active"`.
- Host Config inspect: `include:turbo` reports `status: "schema"` with an
  `enabled` boolean (default true).
- Host Tool inspect lists `read_many`, `workspace_map`, `turbo_parallel_subagents` and `turbo_combine_results` while enabled.
- Web GUI: an **⚡ Турбо** pill sits in the composer row left of the send
  button; clicking it dims/undims and actually gates the tools (check Tool
  inspect after flipping).

## Ideas for v2

- `edit_many` / `write_many`: atomic multi-file writes through the sandbox
  controller (needs the write-intent machinery from `dsh-tool-fs`).
- Repeat-read dedup: a `tools/post-execute` hook that compresses a re-read of
  a file whose `fs/observed` version is unchanged into a one-line pointer.
- Workspace-outline cache injected as a prompt variable on agent creation.
