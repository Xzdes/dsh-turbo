/**
 * dsh-turbo — agent speed pack (host half).
 *
 * Cuts model round-trips, the dominant wall-clock cost of an agent step:
 *
 *   read_many                — one call reads many files at once; every entry may be an
 *                              exact path or a glob (`*`, `**`, `?`). Replaces the
 *                              serial glob → read → read → … exploration chain.
 *   workspace_map            — one call renders the workspace tree with file sizes,
 *                              replacing orientation loops of glob/list calls.
 *   turbo_parallel_subagents — splits a task into independent subagents and prepares a
 *                              parallel execution plan.
 *   turbo_combine_results    — merges the outputs of parallel subagents.
 *   prompt section           — standing guidance that pushes the model to batch
 *                              independent tool calls into a single turn.
 *   agent/request hook       — while the switch is on, every model request is forced
 *                              to the configured reasoning effort (default "low"), so
 *                              the "deep diving" phase gets short and cheap. Turning
 *                              the switch off performs a one-shot restore of each
 *                              touched session's pre-turbo effort.
 *
 * The `enabled` Config field is the master switch. It is `.volatile()`: the
 * settings service only surfaces volatile fields in its live form (which is
 * what the composer button reads/writes through `remote.settings`), and the
 * loader commits volatile edits IN PLACE — no fiber restart. The apply below
 * listens to `loader/volatile-update` and mounts/unmounts every registration
 * when the flag flips.
 *
 * Tool definitions are hand-built against the raw ToolDefinition contract
 * (JSON Schema parameters); all file access goes through the composed
 * `ctx.fs` seam, so sandboxing and observation policy keep working exactly
 * as for the built-in `read`.
 */
import z from "@deepseek-ai/schemastery";

/** Cordis plugin name used by loader diagnostics. */
const name = "turbo";

/** Services required by the speed-pack tool suite and the effort hook. */
const inject = ["tools", "fs", "systemPrompt", "llm"];

/**
 * Live-editable plugin config. Every field is volatile: the parsed value is a
 * stable Volatile ref — read it with `config.<field>.get()`; the loader
 * rewrites the snapshot on live edits instead of restarting this fiber.
 */
const Config = z.object({
  /** Master switch: speed tools + prompt section + effort forcing. */
  enabled: z.boolean().default(true).volatile(),
  /** When true (and enabled), the agent/request hook forces `effort`. */
  effortControl: z.boolean().default(true).volatile(),
  /** Forced reasoning effort: off | low | medium | high ("" = don't touch). */
  effort: z.string().default("low").volatile(),
});

/** Directories never descended into during glob walks and maps. */
const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "__pycache__",
  ".next", ".nuxt", ".turbo", ".cache", ".parcel-cache",
]);

/** Hard caps guarding one call against unbounded work. */
const MAX_FILES_CAP = 60;
const LINES_PER_FILE_CAP = 2000;
const TOTAL_CHARS_CAP = 600000;
const WALK_ENTRIES_CAP = 20000;
const MAP_ENTRIES_CAP = 2000;
const MAP_DEPTH_CAP = 8;

const DEFAULT_MAX_FILES = 24;
const DEFAULT_LINES_PER_FILE = 400;
const DEFAULT_TOTAL_CHARS = 240000;
const DEFAULT_MAP_DEPTH = 4;
const DEFAULT_MAP_ENTRIES = 600;

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** The session workspace cwd for this call, mirroring dsh-tool-fs. */
function sessionCwd(exec) {
  return exec.agent?.session.header.cwd;
}

function escapeRegExp(c) {
  return c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Compile a minimal glob (`*`, `**`, `?`; `/` separators after normalization)
 * into a RegExp matched against the base-relative forward-slash path.
 */
function globToRegExp(glob, caseInsensitive) {
  const g = glob.replace(/\\/g, "/");
  let re = "^";
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === "*") {
      if (g[i + 1] === "*") {
        if (g[i + 2] === "/") { re += "(?:[^/]+/)*"; i += 2; }
        else { re += ".*"; i += 1; }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += escapeRegExp(c);
    }
  }
  return new RegExp(re + "$", caseInsensitive ? "i" : "");
}

function isGlobPattern(p) {
  return /[*?]/.test(p);
}

/** Static directory prefix of a glob: everything before the first magic segment. */
function globStaticPrefix(glob) {
  const normalized = glob.replace(/\\/g, "/");
  const segments = normalized.split("/");
  const staticSegments = [];
  for (const segment of segments) {
    if (/[*?]/.test(segment)) break;
    staticSegments.push(segment);
  }
  return staticSegments.join("/");
}

/** Format a byte count compactly for the map view. */
function formatSize(size) {
  if (size === undefined) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatReadBlock(displayPath, numberedLines, shownFrom, shownTo, totalLines, truncatedByLines) {
  let footer;
  if (truncatedByLines) footer = `(Showing lines ${shownFrom}-${shownTo} of ${totalLines}. Read this file with offset=${shownTo + 1} to continue.)`;
  else footer = `(End of file - total ${totalLines} lines)`;
  const body = numberedLines.length > 0
    ? `${numberedLines.map((line) => `${line.number}: ${line.text}`).join("\n")}\n\n${footer}`
    : footer;
  return `<path>${displayPath}</path>\n<type>file</type>\n<content>\n${body}\n</content>`;
}

/* ------------------------------------------------------------------ */
/* read_many                                                           */
/* ------------------------------------------------------------------ */

function applyReadManyTool(ctx) {
  return ctx.tools.register({
    name: "read_many",
    description:
      "Read many UTF-8 text files in ONE call. Each entry of `paths` may be an exact file path or a glob pattern (`*`, `**`, `?`), resolved against the session working directory. " +
      "Strongly prefer this over issuing many separate read calls or a glob-then-read chain: one call returns every matched file with line numbers. " +
      "Per-file and total caps apply; oversized files are truncated to the first lines with a continuation note.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "File paths and/or glob patterns to read, e.g. [\"src/**/*.ts\", \"package.json\"].",
        },
        max_files: {
          type: "number",
          description: `Maximum number of files to return. Defaults to ${DEFAULT_MAX_FILES}, at most ${MAX_FILES_CAP}.`,
        },
        max_lines_per_file: {
          type: "number",
          description: `Maximum lines returned per file. Defaults to ${DEFAULT_LINES_PER_FILE}, at most ${LINES_PER_FILE_CAP}.`,
        },
        max_total_chars: {
          type: "number",
          description: `Total character budget across all files. Defaults to ${DEFAULT_TOTAL_CHARS}, at most ${TOTAL_CHARS_CAP}.`,
        },
      },
      required: ["paths"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["files", "skipped", "__rendered"],
        properties: {
          files: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "shownLines", "totalLines", "truncated"],
              properties: {
                path: { type: "string" },
                shownLines: { type: "integer" },
                totalLines: { type: "integer" },
                truncated: { type: "boolean" },
              },
            },
          },
          skipped: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["path", "reason"],
              properties: {
                path: { type: "string" },
                reason: { type: "string" },
              },
            },
          },
          __rendered: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.__rendered }],
    },
    timeoutMs: 120000,
    isConcurrencySafe: () => true,
    presentCall(args) {
      const list = Array.isArray(args?.paths) ? args.paths : [];
      return {
        card: "generic",
        title: `Read many (${list.length} pattern${list.length === 1 ? "" : "s"})`,
        kind: "read",
      };
    },
    async execute(args, exec) {
      if (!Array.isArray(args.paths) || args.paths.length === 0) {
        throw new Error("paths must be a non-empty array of file paths or glob patterns");
      }
      const cwd = sessionCwd(exec);
      const caseInsensitive = process.platform === "win32";
      const maxFiles = clampInt(args.max_files, DEFAULT_MAX_FILES, 1, MAX_FILES_CAP, "max_files");
      const linesPerFile = clampInt(args.max_lines_per_file, DEFAULT_LINES_PER_FILE, 1, LINES_PER_FILE_CAP, "max_lines_per_file");
      const totalCharsCap = clampInt(args.max_total_chars, DEFAULT_TOTAL_CHARS, 1000, TOTAL_CHARS_CAP, "max_total_chars");

      // 1. Expand every entry into concrete file targets.
      const skipped = [];
      const seen = new Set();
      const targets = [];
      for (const entry of args.paths) {
        if (typeof entry !== "string" || entry.trim().length === 0) {
          skipped.push({ path: String(entry), reason: "empty or non-string entry" });
          continue;
        }
        if (targets.length >= maxFiles) {
          skipped.push({ path: entry, reason: `max_files (${maxFiles}) already reached` });
          continue;
        }
        if (!isGlobPattern(entry)) {
          try {
            const target = await ctx.fs.resolve(entry, { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal });
            const info = await ctx.fs.stat(target, exec.signal);
            if (info === undefined) { skipped.push({ path: entry, reason: "not found" }); continue; }
            if (info.type !== "file") { skipped.push({ path: entry, reason: "not a regular file" }); continue; }
            if (!seen.has(target.targetKey)) { seen.add(target.targetKey); targets.push({ target, version: info.version }); }
          } catch (error) {
            skipped.push({ path: entry, reason: error instanceof Error ? error.message : String(error) });
          }
          continue;
        }
        // Glob entry: walk from the static prefix.
        const prefix = globStaticPrefix(entry);
        let baseTarget;
        try {
          baseTarget = await ctx.fs.resolve(prefix.length > 0 ? prefix : ".", { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal });
        } catch (error) {
          skipped.push({ path: entry, reason: `cannot resolve base: ${error instanceof Error ? error.message : String(error)}` });
          continue;
        }
        const baseInfo = await ctx.fs.stat(baseTarget, exec.signal);
        if (baseInfo === undefined) { skipped.push({ path: entry, reason: `base directory "${prefix || "."}" not found` }); continue; }
        if (baseInfo.type !== "directory") { skipped.push({ path: entry, reason: `base "${prefix}" is not a directory` }); continue; }
        const matcher = globToRegExp(entry, caseInsensitive);
        const baseDisplay = baseTarget.displayPath.replace(/\\/g, "/").replace(/\/+$/, "");
        const prefixNormalized = prefix.replace(/\\/g, "/").replace(/\/+$/, "");
        let visited = 0;
        let matched = 0;
        const walk = async (dirTarget, dirDisplay, depth) => {
          if (depth > 12 || visited > WALK_ENTRIES_CAP || targets.length >= maxFiles) return;
          let entries;
          try {
            entries = await ctx.fs.listDir(dirTarget, exec.signal);
          } catch {
            return;
          }
          for (const child of entries) {
            if (visited++ > WALK_ENTRIES_CAP || targets.length >= maxFiles) return;
            if (child.type === "directory") {
              if (SKIP_DIRS.has(child.name)) continue;
              await walk(child.target, `${dirDisplay}/${child.name}`, depth + 1);
            } else if (child.type === "file") {
              const childDisplay = `${dirDisplay}/${child.name}`;
              const rel = childDisplay.slice(baseDisplay.length).replace(/^\/+/, "");
              // Match the path exactly as the model wrote it: static prefix + base-relative remainder.
              const matchPath = prefixNormalized.length > 0 ? `${prefixNormalized}/${rel}` : rel;
              if (matcher.test(matchPath)) {
                if (!seen.has(child.target.targetKey)) { seen.add(child.target.targetKey); targets.push({ target: child.target, version: child.version }); matched++; }
              }
            }
          }
        };
        await walk(baseTarget, baseDisplay, 0);
        if (matched === 0) skipped.push({ path: entry, reason: "glob matched no files" });
      }

      // 2. Read every resolved target in parallel.
      const reads = await Promise.all(targets.map(async ({ target, version }) => {
        try {
          const text = await ctx.fs.readText(target, exec.signal);
          ctx.emit("fs/observed", target, { kind: "present", version }, exec);
          return { target, text };
        } catch (error) {
          return { target, error: error instanceof Error ? error.message : String(error) };
        }
      }));

      // 3. Render within the total character budget.
      const files = [];
      const blocks = [];
      let totalChars = 0;
      for (const read of reads) {
        const display = read.target.displayPath;
        if (read.error !== undefined) {
          skipped.push({ path: display, reason: read.error });
          continue;
        }
        const allLines = read.text.split("\n");
        const totalLines = allLines.length;
        const truncated = totalLines > linesPerFile;
        const shown = truncated ? allLines.slice(0, linesPerFile) : allLines;
        const numbered = shown.map((text, index) => ({ number: index + 1, text }));
        const block = formatReadBlock(display, numbered, 1, numbered.length, totalLines, truncated);
        if (totalChars + block.length > totalCharsCap) {
          skipped.push({ path: display, reason: `total character budget (${totalCharsCap}) exhausted` });
          continue;
        }
        totalChars += block.length;
        blocks.push(block);
        files.push({ path: display, shownLines: numbered.length, totalLines, truncated });
      }

      const header = skipped.length > 0
        ? `Skipped ${skipped.length} entr${skipped.length === 1 ? "y" : "ies"}:\n${skipped.map((s) => `- ${s.path}: ${s.reason}`).join("\n")}\n\n`
        : "";
      return {
        files,
        skipped,
        __rendered: blocks.length > 0 ? header + blocks.join("\n\n") : header + "(no files read)",
      };
    },
  });
}

function clampInt(value, fallback, min, max, field) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* workspace_map                                                       */
/* ------------------------------------------------------------------ */

function applyWorkspaceMapTool(ctx) {
  return ctx.tools.register({
    name: "workspace_map",
    description:
      "Render the workspace (or a subdirectory) as an indented tree with file sizes in ONE call. " +
      "Use this first in an unfamiliar workspace instead of chains of glob/list calls. " +
      `Skips noisy directories (${[...SKIP_DIRS].slice(0, 5).join(", ")}, …) unless told otherwise; caps entries and depth.`,
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        path: {
          type: "string",
          description: "Root directory to map. Defaults to the session working directory.",
        },
        max_depth: {
          type: "number",
          description: `Deepest directory level to descend. Defaults to ${DEFAULT_MAP_DEPTH}, at most ${MAP_DEPTH_CAP}.`,
        },
        max_entries: {
          type: "number",
          description: `Maximum rendered entries. Defaults to ${DEFAULT_MAP_ENTRIES}, at most ${MAP_ENTRIES_CAP}.`,
        },
        include_heavy: {
          type: "boolean",
          description: "Also descend into skipped directories like node_modules. Defaults to false.",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["root", "entries", "truncated", "__rendered"],
        properties: {
          root: { type: "string" },
          entries: { type: "integer" },
          truncated: { type: "boolean" },
          __rendered: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.__rendered }],
    },
    timeoutMs: 60000,
    isConcurrencySafe: () => true,
    presentCall(args) {
      return {
        card: "generic",
        title: `Workspace map ${typeof args?.path === "string" ? args.path : ""}`.trim(),
        kind: "search",
      };
    },
    async execute(args, exec) {
      const cwd = sessionCwd(exec);
      const maxDepth = clampInt(args.max_depth, DEFAULT_MAP_DEPTH, 1, MAP_DEPTH_CAP, "max_depth");
      const maxEntries = clampInt(args.max_entries, DEFAULT_MAP_ENTRIES, 10, MAP_ENTRIES_CAP, "max_entries");
      const includeHeavy = args.include_heavy === true;
      const requested = typeof args.path === "string" && args.path.trim().length > 0 ? args.path : ".";
      const root = await ctx.fs.resolve(requested, { ...(cwd !== undefined ? { cwd } : {}), signal: exec.signal });
      const info = await ctx.fs.stat(root, exec.signal);
      if (info === undefined) throw new Error(`cannot map "${requested}": not found`);
      if (info.type !== "directory") throw new Error(`cannot map "${requested}": not a directory`);

      const lines = [`${root.displayPath}/`];
      let count = 0;
      let truncated = false;
      const walk = async (dirTarget, indent, depth) => {
        if (depth > maxDepth || count >= maxEntries) { if (depth <= maxDepth) truncated = true; return; }
        let entries;
        try {
          entries = await ctx.fs.listDir(dirTarget, exec.signal);
        } catch {
          return;
        }
        for (const entry of entries) {
          if (count >= maxEntries) { truncated = true; return; }
          if (entry.type === "directory") {
            if (!includeHeavy && SKIP_DIRS.has(entry.name)) continue;
            count++;
            lines.push(`${indent}${entry.name}/`);
            await walk(entry.target, `${indent}  `, depth + 1);
            if (truncated) return;
          } else {
            count++;
            const size = formatSize(entry.size);
            lines.push(`${indent}${entry.name}${size.length > 0 ? `  (${size})` : ""}`);
          }
        }
      };
      await walk(root, "  ", 1);
      if (truncated) lines.push(`  … (truncated at ${maxEntries} entries or depth ${maxDepth}; map a subdirectory for detail)`);
      return {
        root: root.displayPath,
        entries: count,
        truncated,
        __rendered: lines.join("\n"),
      };
    },
  });
}

/* ------------------------------------------------------------------ */
/* parallel subagents                                                    */
/* ------------------------------------------------------------------ */

/**
 * Plan parallel subagent work. The model must then execute each planned
 * subagent call independently (DSH runs independent tool calls in parallel)
 * and finally call turbo_combine_results to merge the outputs.
 */
function applyParallelSubagentsTool(ctx) {
  return ctx.tools.register({
    name: "turbo_parallel_subagents",
    description:
      "Split a complex request into independent subtasks and prepare parallel subagent calls. " +
      "Returns a plan; the caller must run each subagent independently and then call turbo_combine_results to merge outputs. " +
      "Use this when a problem decomposes into N independent pieces (e.g. audit multiple files, analyze different modules).",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        tasks: {
          type: "array",
          minItems: 2,
          maxItems: 8,
          description: "Independent subtasks to delegate to subagents. Each gets its own subagent.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "description", "prompt"],
            properties: {
              id: {
                type: "string",
                description: "Short kebab-case identifier for this subtask, used when combining results.",
              },
              description: {
                type: "string",
                description: "One-line summary shown in the plan.",
              },
              prompt: {
                type: "string",
                description: "Complete self-contained prompt for the subagent. Include all context it needs; subagents do not share this conversation.",
              },
            },
          },
        },
        combine_instructions: {
          type: "string",
          description: "Optional instructions for how to merge the subagent outputs (tone, format, what to prioritize).",
        },
      },
      required: ["tasks"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["plan", "combine_instructions", "__rendered"],
        properties: {
          plan: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                description: { type: "string" },
                prompt: { type: "string" },
              },
            },
          },
          combine_instructions: { type: "string" },
          __rendered: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.__rendered }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    presentCall(args) {
      const count = Array.isArray(args?.tasks) ? args.tasks.length : 0;
      return {
        card: "generic",
        title: `Parallel subagents plan (${count} tasks)`,
        kind: "search",
      };
    },
    async execute(args, _exec) {
      const tasks = Array.isArray(args.tasks) ? args.tasks : [];
      if (tasks.length < 2) {
        throw new Error("turbo_parallel_subagents requires at least 2 tasks; use a single subagent for one task");
      }
      const ids = new Set();
      for (const task of tasks) {
        if (!task.id || typeof task.id !== "string") throw new Error("every task must have a string id");
        if (!task.prompt || typeof task.prompt !== "string") throw new Error(`task ${task.id} must have a prompt`);
        if (ids.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
        ids.add(task.id);
      }
      const plan = tasks.map((task) => ({
        id: task.id,
        description: typeof task.description === "string" ? task.description : "",
        prompt: task.prompt,
      }));
      const instructions = typeof args.combine_instructions === "string" ? args.combine_instructions : "Combine the subagent results into a single coherent answer. Preserve each task's id so the reader knows which part came from which subagent.";

      const renderedPlan = plan.map((task, index) => `Task ${index + 1} (${task.id}):
${task.description ? `  Description: ${task.description}\n` : ""}  Subagent prompt:
${task.prompt.split("\n").map((line) => `    ${line}`).join("\n")}`).join("\n\n");

      return {
        plan,
        combine_instructions: instructions,
        __rendered: `Parallel execution plan:\n\n${renderedPlan}\n\nAfter all subagents finish, call turbo_combine_results(results=[{id, result}, ...]) to merge their outputs.\n\nCombine instructions: ${instructions}`,
      };
    },
  });
}

/**
 * Merge the outputs of parallel subagents into a single coherent response.
 */
function applyCombineResultsTool(ctx) {
  return ctx.tools.register({
    name: "turbo_combine_results",
    description:
      "Combine the text outputs of parallel subagents into one coherent result. " +
      "Use after all subagents spawned by turbo_parallel_subagents have returned.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        results: {
          type: "array",
          minItems: 1,
          description: "Results from each subagent, in any order. Each entry must contain the task id and the subagent's final result text.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "result"],
            properties: {
              id: {
                type: "string",
                description: "Task id from the original turbo_parallel_subagents plan.",
              },
              result: {
                type: "string",
                description: "Final text returned by the subagent for this task.",
              },
            },
          },
        },
        combine_instructions: {
          type: "string",
          description: "Optional instructions for how to merge the results (tone, format, what to prioritize).",
        },
      },
      required: ["results"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["combined", "__rendered"],
        properties: {
          combined: { type: "string" },
          __rendered: { type: "string" },
        },
      },
      render: (_args, value) => [{ type: "text", text: value.__rendered }],
    },
    timeoutMs: 30000,
    isConcurrencySafe: () => true,
    presentCall(args) {
      const count = Array.isArray(args?.results) ? args.results.length : 0;
      return {
        card: "generic",
        title: `Combine results (${count})`,
        kind: "search",
      };
    },
    async execute(args, _exec) {
      const results = Array.isArray(args.results) ? args.results : [];
      if (results.length === 0) throw new Error("results must be a non-empty array");
      const instructions = typeof args.combine_instructions === "string" ? args.combine_instructions : "";
      const header = instructions ? `Combined results (${instructions}):\n\n` : "Combined results:\n\n";
      const body = results.map((entry) => `## ${entry.id}\n\n${typeof entry.result === "string" ? entry.result : "(no result text)"}`).join("\n\n---\n\n");
      const combined = `${header}${body}`;
      return { combined, __rendered: combined };
    },
  });
}

/* ------------------------------------------------------------------ */
/* prompt section                                                      */
/* ------------------------------------------------------------------ */

function applySpeedSection(ctx) {
  return ctx.systemPrompt.section({
    name: "turbo:speed",
    order: 1550,
    text: ({ scope }) => {
      if (ctx.tools.get("read_many", scope) === undefined) return "";
      return [
        "Speed guidance (dsh-turbo) — minimize wall-clock, every turn:",
        "- Exploring several files? Call read_many ONCE with all paths or a glob (e.g. \"src/**/*.ts\") instead of a glob-then-read chain or many separate read calls.",
        "- New to a workspace? Start with workspace_map to see the tree and file sizes in one call.",
        "- Independent tool calls (reads, greps, globs, maps) — emit ALL of them in one assistant turn so they run in parallel; never wait for one result before issuing an unrelated call.",
        "- Read each file once. Do not re-read content you already have; use offset/limit only to continue a truncated file.",
        "- Plan once, then execute. Avoid speculative detours and confirmation round-trips; act on the evidence you already hold.",
        "- Keep intermediate narration minimal — every extra assistant turn costs a full model round-trip.",
        "- Prefer one precise edit over several small ones; verify with a single targeted read instead of a full re-read.",
        "- Independent subtasks? Use turbo_parallel_subagents to split work, run the resulting subagent calls in parallel, then merge with turbo_combine_results.",
      ].join("\n");
    },
  });
}

/* ------------------------------------------------------------------ */
/* reasoning effort hook                                               */
/* ------------------------------------------------------------------ */

/** Reasoning-effort ids the hook may force. */
const EFFORT_LEVELS = ["off", "low", "medium", "high"];

/** How long one positive/negative capability lookup is trusted. */
const EFFORT_CACHE_TTL_MS = 60000;

function normalizeEffort(value) {
  const normalized = String(value === undefined || value === null ? "" : value).trim().toLowerCase();
  return EFFORT_LEVELS.includes(normalized) ? normalized : "";
}

/**
 * Whether `provider/model` declares `effort`. The pi-ai adapter throws
 * UNSUPPORTED_REASONING_EFFORT for a request carrying a level the model does
 * not offer, so the hook must never inject blindly. The reasoning metadata
 * lives in `llm.resolveModelInfo()` — the same seam buildModelCatalog and
 * list_subagent_models use; `llm.listModels()` entries carry NO reasoning
 * field, so probing them always reports "unsupported". Lookup failures (llm
 * service absent, unknown route) are cached briefly and treated as
 * "unsupported" — the request then proceeds with its own effort.
 */
async function modelSupportsEffort(ctx, provider, model, effort, cache) {
  if (typeof provider !== "string" || provider === "" || typeof model !== "string" || model === "") return false;
  const key = `${provider}\u0000${model}\u0000${effort}`;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit !== undefined && now - hit.at < EFFORT_CACHE_TTL_MS) return hit.ok;
  let ok = false;
  try {
    const llm = ctx.get("llm");
    if (llm !== undefined && typeof llm.resolveModelInfo === "function") {
      const info = await llm.resolveModelInfo(provider, model);
      const efforts = info !== undefined && info !== null && info.reasoning !== undefined && info.reasoning !== null ? info.reasoning.efforts : undefined;
      ok = Array.isArray(efforts) && efforts.some((level) => (level !== null && typeof level === "object" ? level.id : level) === effort);
    }
  } catch {
    ok = false;
  }
  cache.set(key, { at: now, ok });
  return ok;
}

/**
 * Force the reasoning effort on every LLM request while the pack is on.
 *
 * Mounted ONCE for the fiber lifetime (deliberately not part of sync()):
 * the middleware reads the volatile config per request, and it must stay
 * alive across the on→off flip to perform the one-shot restore — DSH persists
 * each request's effective config in the session header and replays it as the
 * next request's seed, so without the restore a session that ran under turbo
 * would keep the turbo effort forever after the switch turns off.
 *
 * Ordering: cordis waterfall listeners run outermost-first in registration
 * order (EventsService.waterfall shifts the callback queue; the first
 * registered callback wraps all later ones). This hook registers at plugin
 * load (boot) with `prepend: true` — the outermost layer, ahead of any
 * per-agent model-selection middleware registered later — so the override
 * applied here after `await next()` is the final word: while turbo is on it
 * wins over any session/GUI selection, exactly like the built-in
 * installModelSelection wins over the persisted seed.
 */
function applyEffortHook(ctx, config) {
  const supportCache = new Map();
  /** agent -> { had, value }: the pre-turbo effort, for the one-shot restore. */
  const touched = new WeakMap();
  return ctx.on("agent/request", async (payload, next) => {
    const resolved = await next();
    if (resolved === null || typeof resolved !== "object") return resolved;
    const agent = payload !== undefined && payload !== null ? payload.agent : undefined;
    const active = config.enabled.get() !== false && config.effortControl.get() !== false;
    const effort = active ? normalizeEffort(config.effort.get()) : "";
    if (effort !== "" && agent !== undefined && agent !== null) {
      if (!(await modelSupportsEffort(ctx, resolved.provider, resolved.model, effort, supportCache))) return resolved;
      if (!touched.has(agent)) {
        touched.set(agent, { had: resolved.reasoningEffort !== undefined, value: resolved.reasoningEffort });
      }
      if (resolved.reasoningEffort === effort) return resolved;
      return { ...resolved, reasoningEffort: effort };
    }
    // Switched off (or effort cleared): one-shot restore of the pre-turbo effort.
    if (agent !== undefined && agent !== null && touched.has(agent)) {
      const restore = touched.get(agent);
      touched.delete(agent);
      if (restore.had) return { ...resolved, reasoningEffort: restore.value };
      const { reasoningEffort: _dropped, ...withoutEffort } = resolved;
      return withoutEffort;
    }
    return resolved;
  }, { prepend: true });
}

/* ------------------------------------------------------------------ */
/* entry                                                               */
/* ------------------------------------------------------------------ */

function apply(ctx, config) {
  /**
   * Volatile master switch: registrations are mounted/unmounted in place.
   * The loader commits volatile config edits without a fiber restart and
   * notifies us through `loader/volatile-update`; sync() is idempotent.
   */
  let disposers = null;
  const sync = () => {
    const enabled = config.enabled.get() !== false;
    if (enabled && disposers === null) {
      disposers = [
        applyReadManyTool(ctx),
        applyWorkspaceMapTool(ctx),
        applyParallelSubagentsTool(ctx),
        applyCombineResultsTool(ctx),
        applySpeedSection(ctx),
      ];
    } else if (!enabled && disposers !== null) {
      for (const dispose of disposers) dispose();
      disposers = null;
    }
  };
  ctx.on("loader/volatile-update", sync);
  sync();

  /**
   * The effort hook lives for the whole fiber lifetime and reads the volatile
   * config on every request; staying mounted after the off flip is what makes
   * the one-shot per-session effort restore possible.
   */
  applyEffortHook(ctx, config);
}

/** Display metadata for the Plugins page (LocalizedText: language maps, `en` required). */
const meta = {
  title: {
    en: "Agent speed pack",
    ru: "Пакет ускорения агента",
  },
  description: {
    en: "Cuts agent round-trips AND thinking time: read_many reads many files (globs included) in one call, workspace_map renders the project tree in one call, prompt guidance pushes the model to batch independent tool calls, and while the toggle is on every request is forced to a fast reasoning-effort level (right-click the pill to change it). Adds a Turbo toggle next to the composer send button.",
    ru: "Сокращает число шагов агента и время размышлений: read_many читает много файлов (включая glob-шаблоны) за один вызов, workspace_map показывает дерево проекта за один вызов, подсказка в системном промпте учит модель пакетировать независимые вызовы инструментов, а пока переключатель включён, каждый запрос принудительно идёт на быстром уровне рассуждений (уровень меняется правым кликом по кнопке). Добавляет кнопку «Турбо» рядом с кнопкой отправки.",
  },
};

export { Config, apply, inject, meta, name };
