Di seguito trovi un **server MCP in TypeScript** che implementa un ciclo di **miglioramento ricorsivo stile TRM** per sviluppo codice più affidabile/ottimizzato, pensato per lavorare **in sinergia** con tool LLM come **Claude Code, Cursor e Codex CLI** (quindi il server NON fa codegen: si limita a valutare, dare feedback strutturato, calcolare un punteggio/EMA, e decidere l’halting).

L’LLM diventa l’“ottimizzatore” che propone patch; il server MCP è il “critico/valutatore” ricorsivo con stato, test, build, lint, benchmark e **policy di stop** (ACT semplificato).

---

### File structure

```
mcp-trm-server/
  package.json
  tsconfig.json
  src/server.ts
```

---

### package.json

```json
{
  "name": "mcp-trm-server",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "bin": {
    "mcp-trm-server": "dist/server.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^0.2.0",
    "execa": "^9.4.0",
    "fs-extra": "^11.2.0",
    "picocolors": "^1.0.0",
    "uuid": "^9.0.1"
  },
  "devDependencies": {
    "@types/node": "^22.5.0",
    "typescript": "^5.6.3"
  }
}
```

---

### tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

---

### src/server.ts

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/transports/node.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Tool, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { v4 as uuidv4 } from "uuid";
import fs from "fs-extra";
import path from "path";
import { execa } from "execa";
import pc from "picocolors";

/**
 * TRM-inspired MCP server for recursive code refinement.
 *
 * Design:
 * - The LLM client (Claude Code / Cursor / Codex CLI) proposes code changes.
 * - This server evaluates candidates (build/test/lint/bench), computes scores,
 *   tracks EMA and improvement deltas, and exposes a halting policy (ACT-like).
 * - State: y=current candidate (implicit in workspace files), z=rationale/notes,
 *   history of evaluations, EMA of score.
 *
 * Tools:
 *  - trm.startSession        : init session on a repo path + commands to run
 *  - trm.submitCandidate     : apply candidate changes (files or unified diff), run eval, return feedback + shouldHalt
 *  - trm.getState            : snapshot of scores/history
 *  - trm.shouldHalt          : return current halting decision
 *  - trm.endSession          : cleanup
 *
 * Scoring:
 *  score in [0..1] from weighted signals:
 *   - tests: passed/total (required if provided)
 *   - build: success/fail
 *   - lint: success/fail (optional)
 *   - perf: normalized vs best-so-far (optional)
 *
 * Halting:
 *  shouldHalt = true if:
 *    - all tests pass AND score >= passThreshold, OR
 *    - no improvement for K consecutive steps, OR
 *    - steps >= maxSteps
 *
 * Safe execution:
 *  - Commands executed in provided repoPath with timeouts.
 *  - No network access, only local cmds.
 */

type SessionId = string;

type SessionConfig = {
  repoPath: string;
  buildCmd?: string;       // e.g., "npm run build" or "tsc -p . --noEmit"
  testCmd?: string;        // e.g., "npm test --silent -- --reporter=json"
  lintCmd?: string;        // e.g., "npm run lint" or "eslint ."
  benchCmd?: string;       // optional perf
  timeoutSec?: number;     // per cmd timeout
  weights: {
    build: number; // 0..1
    test: number;  // 0..1
    lint: number;  // 0..1
    perf: number;  // 0..1
  };
  halt: {
    maxSteps: number;          // hard limit
    passThreshold: number;     // score to accept when tests pass
    patienceNoImprove: number; // steps without improvement
    minSteps?: number;         // optional minimum before halting
  };
};

type EvalResult = {
  okBuild?: boolean;
  okLint?: boolean;
  tests?: { passed: number; failed: number; total: number; raw?: string };
  perf?: { value: number; unit?: string }; // lower-is-better by default, configurable if needed
  score: number;           // 0..1
  emaScore: number;        // 0..1
  step: number;            // 1-based
  feedback: string[];      // compact actionable signals for LLM
  shouldHalt: boolean;
  reasons: string[];
};

type SessionState = {
  id: SessionId;
  cfg: SessionConfig;
  createdAt: number;
  step: number;
  bestScore: number;
  emaScore: number;
  emaAlpha: number; // e.g., 0.9
  noImproveStreak: number;
  history: EvalResult[];
  // TRM-like latent memo (optional); LLM may supply rationale here
  zNotes?: string;
  // perf baseline to normalize (best lower value)
  bestPerf?: number;
};

const sessions = new Map<SessionId, SessionState>();

// ------------- helpers ----------------

function clamp01(x: number) { return Math.max(0, Math.min(1, x)); }

async function runCmd(cmd: string | undefined, cwd: string, timeoutSec: number): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number | null }> {
  if (!cmd) return { ok: true, stdout: "", stderr: "", exitCode: 0 };
  const [bin, ...args] = cmd.split(" ");
  try {
    const { stdout, stderr, exitCode } = await execa(bin, args, { cwd, timeout: timeoutSec * 1000, shell: false });
    return { ok: (exitCode ?? 0) === 0, stdout, stderr, exitCode: exitCode ?? 0 };
  } catch (err: any) {
    return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? String(err), exitCode: err.exitCode ?? -1 };
  }
}

function parseTestOutput(raw: string): { passed: number; failed: number; total: number } | null {
  // Try to detect jest/mocha minimal info heuristically
  // Accepts either JSON reporters or summary lines.
  try {
    // If JSON array/object with aggregateResults (Jest)
    const j = JSON.parse(raw);
    if (j && typeof j === "object") {
      if (j.numPassedTests !== undefined && j.numFailedTests !== undefined && j.numTotalTests !== undefined) {
        return { passed: j.numPassedTests, failed: j.numFailedTests, total: j.numTotalTests };
      }
      // Vitest reporter?
      if (j.stats?.passed !== undefined && j.stats?.failed !== undefined && j.stats?.tests !== undefined) {
        return { passed: j.stats.passed, failed: j.stats.failed, total: j.stats.tests };
      }
    }
  } catch {/* not JSON */}
  // Fallback: regex on summary line
  const m = raw.match(/Tests?:\s*(\d+)\s*passed.*?(\d+)\s*total/i) || raw.match(/(\d+)\s*passing.*?(\d+)\s*total/i);
  if (m) {
    const passed = Number(m[1]);
    const total = Number(m[2]);
    return { passed, failed: total - passed, total };
  }
  // Another common: "passed X, failed Y, total Z"
  const m2 = raw.match(/passed\s*:\s*(\d+).*failed\s*:\s*(\d+).*total\s*:\s*(\d+)/i);
  if (m2) {
    const passed = Number(m2[1]), failed = Number(m2[2]), total = Number(m2[3]);
    return { passed, failed, total };
  }
  return null;
}

function scoreFromSignals(state: SessionState, signals: {
  buildOk: boolean;
  lintOk: boolean;
  tests?: { passed: number; total: number };
  perf?: { value: number };
}): number {
  const w = state.cfg.weights;
  let sBuild = signals.buildOk ? 1 : 0;
  let sLint = signals.lintOk ? 1 : 0;

  let sTests = 0;
  if (signals.tests && signals.tests.total > 0) {
    sTests = clamp01(signals.tests.passed / signals.tests.total);
  } else if (state.cfg.testCmd) {
    // If tests expected but no parse, be conservative:
    sTests = 0;
  }

  // perf: if we have a bestPerf as lower-is-better baseline, normalize in (0,1]
  let sPerf = 0;
  if (signals.perf && isFinite(signals.perf.value)) {
    if (state.bestPerf === undefined) {
      state.bestPerf = signals.perf.value;
      sPerf = 1; // first observation is best so far
    } else {
      // normalize inversely: score = clamp(best/perf, 0..1)
      if (signals.perf.value <= 0) {
        sPerf = 0;
      } else {
        sPerf = clamp01(state.bestPerf / signals.perf.value);
        if (signals.perf.value < state.bestPerf) state.bestPerf = signals.perf.value;
      }
    }
  } else if (state.cfg.benchCmd) {
    // Expected perf but missing -> 0
    sPerf = 0;
  }

  const sumW = w.build + w.test + w.lint + w.perf || 1;
  const score = clamp01((w.build * sBuild + w.test * sTests + w.lint * sLint + w.perf * sPerf) / sumW);
  return score;
}

function shouldHalt(state: SessionState, last: EvalResult): { halt: boolean; reasons: string[] } {
  const r: string[] = [];
  const cfg = state.cfg.halt;
  const minSteps = cfg.minSteps ?? 1;

  const testsPass = last.tests && last.tests.total > 0 && last.tests.passed === last.tests.total;

  if (state.step >= minSteps && testsPass && last.score >= cfg.passThreshold) {
    r.push(`tests pass and score ${last.score.toFixed(3)} ≥ threshold ${cfg.passThreshold}`);
    return { halt: true, reasons: r };
  }

  if (state.noImproveStreak >= cfg.patienceNoImprove) {
    r.push(`no improvement for ${state.noImproveStreak} steps (patience=${cfg.patienceNoImprove})`);
    return { halt: true, reasons: r };
  }

  if (state.step >= cfg.maxSteps) {
    r.push(`reached max steps ${cfg.maxSteps}`);
    return { halt: true, reasons: r };
  }

  return { halt: false, reasons: [] };
}

function diffHints(stderr: string, stdout: string): string[] {
  const hints: string[] = [];
  const out = `${stdout}\n${stderr}`;
  // Compact actionable hints (non-exhaustive)
  const tsErrs = out.match(/^(.+:\d+:\d+ - error .+)$/gmi);
  if (tsErrs) hints.push(...tsErrs.slice(0, 10));
  const jestFail = out.match(/● .*? \((\d+)ms\)/g);
  if (jestFail) hints.push(...jestFail.slice(0, 10));
  const eslintErr = out.match(/error\s+.+\s+\(.+?\)/g);
  if (eslintErr) hints.push(...eslintErr.slice(0, 10));
  // Fallback generic lines
  if (hints.length === 0) {
    const lines = out.split(/\r?\n/).filter(l => l.trim().length && l.length < 240);
    hints.push(...lines.slice(0, 10));
  }
  return [...new Set(hints)];
}

async function applyCandidate(
  repoPath: string,
  candidate: { mode: "files"; files: { path: string; content: string }[] } |
             { mode: "patch"; patch: string }
) {
  if (candidate.mode === "files") {
    for (const f of candidate.files) {
      const abs = path.resolve(repoPath, f.path);
      await fs.ensureDir(path.dirname(abs));
      await fs.writeFile(abs, f.content, "utf8");
    }
    return;
  } else {
    // apply unified diff using `git apply --whitespace=fix`
    await execa("git", ["apply", "--whitespace=fix", "--reject"], { cwd: repoPath });
    // If we want to apply the provided patch directly:
    const { execaNode } = await import("execa"); // dynamic not needed, but ok
    // Simpler: spawn `git apply -` with stdin
    await execa("git", ["apply", "--whitespace=fix"], { cwd: repoPath, input: candidate.patch });
  }
}

// ------------- MCP server ----------------

const transport = new StdioServerTransport();
const server = new Server(
  {
    name: "mcp-trm-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {
        listChanged: true,
      },
      resources: {},
    },
  }
);

const tools: Tool[] = [
  {
    name: "trm.startSession",
    description: "Initialize a TRM session on a local repository with evaluation commands and halting policy.",
    inputSchema: {
      type: "object",
      properties: {
        repoPath: { type: "string", description: "Absolute path to the project repository" },
        buildCmd: { type: "string" },
        testCmd: { type: "string" },
        lintCmd: { type: "string" },
        benchCmd: { type: "string" },
        timeoutSec: { type: "number", default: 120 },
        weights: {
          type: "object",
          properties: {
            build: { type: "number", default: 0.3 },
            test: { type: "number", default: 0.5 },
            lint: { type: "number", default: 0.1 },
            perf: { type: "number", default: 0.1 }
          },
          required: []
        },
        halt: {
          type: "object",
          properties: {
            maxSteps: { type: "number", default: 12 },
            passThreshold: { type: "number", default: 0.95 },
            patienceNoImprove: { type: "number", default: 3 },
            minSteps: { type: "number", default: 1 }
          },
          required: ["maxSteps", "passThreshold", "patienceNoImprove"]
        },
        emaAlpha: { type: "number", default: 0.9 },
        zNotes: { type: "string", description: "Optional initial reasoning notes/hints" }
      },
      required: ["repoPath", "halt"]
    }
  },
  {
    name: "trm.submitCandidate",
    description: "Apply candidate changes (files or unified diff), run evaluation (build/test/lint/bench), update EMA & state, and return feedback + shouldHalt.",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        candidate: {
          oneOf: [
            {
              type: "object",
              properties: {
                mode: { const: "files" },
                files: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      path: { type: "string" },
                      content: { type: "string" }
                    },
                    required: ["path", "content"]
                  }
                }
              },
              required: ["mode", "files"]
            },
            {
              type: "object",
              properties: {
                mode: { const: "patch" },
                patch: { type: "string" }
              },
              required: ["mode", "patch"]
            }
          ]
        },
        rationale: { type: "string", description: "LLM notes: why these changes, expected effects, hypotheses" }
      },
      required: ["sessionId", "candidate"]
    }
  },
  {
    name: "trm.getState",
    description: "Return current TRM state (scores, EMA, history summary).",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.shouldHalt",
    description: "Return halting decision based on latest evaluation.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  },
  {
    name: "trm.endSession",
    description: "End and remove a TRM session.",
    inputSchema: {
      type: "object",
      properties: { sessionId: { type: "string" } },
      required: ["sessionId"]
    }
  }
];

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = tools.find(t => t.name === req.params.name);
  if (!tool) {
    return { content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }] };
  }

  try {
    switch (req.params.name) {
      case "trm.startSession": {
        const p = req.params.arguments as any;
        const id: SessionId = uuidv4();
        const cfg: SessionConfig = {
          repoPath: p.repoPath,
          buildCmd: p.buildCmd,
          testCmd: p.testCmd,
          lintCmd: p.lintCmd,
          benchCmd: p.benchCmd,
          timeoutSec: p.timeoutSec ?? 120,
          weights: {
            build: p.weights?.build ?? 0.3,
            test: p.weights?.test ?? 0.5,
            lint: p.weights?.lint ?? 0.1,
            perf: p.weights?.perf ?? 0.1
          },
          halt: {
            maxSteps: p.halt.maxSteps,
            passThreshold: p.halt.passThreshold,
            patienceNoImprove: p.halt.patienceNoImprove,
            minSteps: p.halt.minSteps ?? 1
          }
        };
        const state: SessionState = {
          id,
          cfg,
          createdAt: Date.now(),
          step: 0,
          bestScore: 0,
          emaScore: 0,
          emaAlpha: p.emaAlpha ?? 0.9,
          noImproveStreak: 0,
          history: [],
          zNotes: p.zNotes || undefined
        };
        sessions.set(id, state);
        return {
          content: [{ type: "json", json: { sessionId: id, message: "TRM session started" } }]
        };
      }

      case "trm.submitCandidate": {
        const p = req.params.arguments as any;
        const state = sessions.get(p.sessionId);
        if (!state) {
          return { content: [{ type: "text", text: `Unknown session: ${p.sessionId}` }] };
        }

        // Apply candidate
        await applyCandidate(state.cfg.repoPath, p.candidate);
        if (typeof p.rationale === "string" && p.rationale.trim().length) {
          // Keep only the latest rationale (TRM z feature)
          state.zNotes = p.rationale.slice(0, 4000);
        }

        // Evaluate
        state.step += 1;
        const tSec = state.cfg.timeoutSec ?? 120;

        const build = await runCmd(state.cfg.buildCmd, state.cfg.repoPath, tSec);
        const lint = await runCmd(state.cfg.lintCmd, state.cfg.repoPath, Math.max(30, tSec / 2));
        const test = await runCmd(state.cfg.testCmd, state.cfg.repoPath, tSec);
        const bench = await runCmd(state.cfg.benchCmd, state.cfg.repoPath, tSec);

        const testParsed = state.cfg.testCmd ? parseTestOutput(test.stdout || test.stderr || "") : null;

        const score = scoreFromSignals(state, {
          buildOk: build.ok,
          lintOk: lint.ok,
          tests: testParsed ? { passed: testParsed.passed, total: testParsed.total } : undefined,
          perf: state.cfg.benchCmd ? { value: parseFloat((bench.stdout || bench.stderr).match(/([\d.]+)$/)?.[1] || "NaN") } : undefined
        });

        // EMA
        state.emaScore = state.step === 1 ? score : (state.emaAlpha * state.emaScore + (1 - state.emaAlpha) * score);

        // Improvement tracking
        let improved = false;
        if (score > state.bestScore + 1e-6) {
          state.bestScore = score;
          improved = true;
          state.noImproveStreak = 0;
        } else {
          state.noImproveStreak += 1;
        }

        const feedback: string[] = [];
        if (!build.ok) feedback.push("Build failed – fix compilation/type errors.");
        if (state.cfg.testCmd) {
          if (!testParsed) {
            feedback.push("Tests output not parsed – prefer JSON reporter or include summary lines.");
          } else {
            feedback.push(`Tests: ${testParsed.passed}/${testParsed.total} passed.`);
            if (testParsed.failed > 0) feedback.push(`There are ${testParsed.failed} failing tests.`);
          }
        }
        if (state.cfg.lintCmd && !lint.ok) {
          feedback.push("Lint failed – fix style/static-analysis issues.");
        }
        if (state.cfg.benchCmd && bench.ok) {
          feedback.push("Benchmark executed – try improving critical hot paths while keeping correctness.");
        }

        const hintLines = [
          ...diffHints(build.stderr, build.stdout),
          ...diffHints(test.stderr, test.stdout),
          ...diffHints(lint.stderr, lint.stdout)
        ].slice(0, 12);

        const evalResult: EvalResult = {
          okBuild: build.ok,
          okLint: lint.ok,
          tests: testParsed ? { ...testParsed, raw: "" } : undefined,
          perf: state.cfg.benchCmd && isFinite(Number(bench.stdout)) ? { value: Number(bench.stdout) } : undefined,
          score,
          emaScore: state.emaScore,
          step: state.step,
          feedback: [...new Set([...feedback, ...hintLines])].slice(0, 16),
          shouldHalt: false,
          reasons: []
        };

        const haltDecision = shouldHalt(state, evalResult);
        evalResult.shouldHalt = haltDecision.halt;
        evalResult.reasons = haltDecision.reasons;

        state.history.push(evalResult);

        const compact = {
          step: evalResult.step,
          score: evalResult.score,
          emaScore: evalResult.emaScore,
          bestScore: state.bestScore,
          noImproveStreak: state.noImproveStreak,
          tests: evalResult.tests,
          okBuild: evalResult.okBuild,
          okLint: evalResult.okLint,
          shouldHalt: evalResult.shouldHalt,
          reasons: evalResult.reasons,
          feedback: evalResult.feedback
        };

        return { content: [{ type: "json", json: compact }] };
      }

      case "trm.getState": {
        const p = req.params.arguments as any;
        const state = sessions.get(p.sessionId);
        if (!state) return { content: [{ type: "text", text: `Unknown session: ${p.sessionId}` }] };

        const last = state.history[state.history.length - 1];
        return {
          content: [{
            type: "json",
            json: {
              sessionId: state.id,
              step: state.step,
              emaScore: state.emaScore,
              bestScore: state.bestScore,
              noImproveStreak: state.noImproveStreak,
              last,
              zNotes: state.zNotes
            }
          }]
        };
      }

      case "trm.shouldHalt": {
        const p = req.params.arguments as any;
        const state = sessions.get(p.sessionId);
        if (!state) return { content: [{ type: "text", text: `Unknown session: ${p.sessionId}` }] };
        const last = state.history[state.history.length - 1];
        if (!last) return { content: [{ type: "json", json: { shouldHalt: false, reasons: ["no evaluations yet"] } }] };
        const d = shouldHalt(state, last);
        return { content: [{ type: "json", json: { shouldHalt: d.halt, reasons: d.reasons } }] };
      }

      case "trm.endSession": {
        const p = req.params.arguments as any;
        sessions.delete(p.sessionId);
        return { content: [{ type: "json", json: { ok: true } }] };
      }

      default:
        return { content: [{ type: "text", text: `Unhandled tool: ${req.params.name}` }] };
    }
  } catch (err: any) {
    return { content: [{ type: "text", text: `Error: ${String(err?.message ?? err)}` }] };
  }
});

await server.connect(transport);
console.error(pc.dim(`[mcp-trm-server] ready on stdio`));
```

---

## Come usarlo con Claude Code / Cursor / Codex CLI

1. **Build & run**

```bash
pnpm i
pnpm build
# Il bin è "mcp-trm-server" (dist/server.js). Per test locale:
pnpm start
```

2. **Agganciare il server MCP**

* **Claude Code** (VS Code): apri le impostazioni “Model Context Protocol”, aggiungi un MCP Server con:

  * **Command**: `mcp-trm-server`
  * **Args**: *(vuoto)*
* **Cursor**: Settings → MCP / “Custom MCP Servers” → add:

  * Command: `mcp-trm-server`
* **Codex CLI** (o altri client MCP): punta a `mcp-trm-server` via stdio.

*(I client MCP avviano il bin e dialogano via stdio automaticamente.)*

3. **Workflow consigliato (prompt lato LLM)**

* Avvia la sessione:

```json
{
  "tool": "trm.startSession",
  "arguments": {
    "repoPath": "/abs/path/progetto",
    "buildCmd": "tsc -p . --noEmit",
    "testCmd": "npm test --silent -- --reporter=json",
    "lintCmd": "npm run lint",
    "benchCmd": "node scripts/bench.js",
    "weights": { "build": 0.25, "test": 0.55, "lint": 0.10, "perf": 0.10 },
    "halt": { "maxSteps": 12, "passThreshold": 0.97, "patienceNoImprove": 3, "minSteps": 2 },
    "emaAlpha": 0.9,
    "zNotes": "Target: ridurre allocazioni nel parser e coprire edge-case X."
  }
}
```

* **Ciclo ricorsivo stile TRM** (guidare l’LLM):

  1. **Proponi patch minima** per un obiettivo micro (es. fix test rosso o micro-ottimizzazione hotspot).
  2. Chiama `trm.submitCandidate` con:

     * `candidate.mode: "files"` e array di `{path, content}` **oppure** `mode: "patch"` con unified diff.
     * `rationale`: *perché quella modifica migliora score/test/perf*, ipotesi e rischio regressioni.
  3. Leggi `feedback`, `score`, `emaScore`, `tests`, `noImproveStreak`.
  4. Se `shouldHalt=false`, ripeti: proponi una nuova patch piccola e mirata.
  5. Se `shouldHalt=true`, termina.

* Esempio `submitCandidate` (files):

```json
{
  "tool": "trm.submitCandidate",
  "arguments": {
    "sessionId": "…",
    "candidate": {
      "mode": "files",
      "files": [
        { "path": "src/parser/lexer.ts", "content": "/* nuovo contenuto TS completo qui */" }
      ]
    },
    "rationale": "Elimino allocazioni temporanee in hot loop; aggiungo fast-path per ASCII; mantengo comportamenti invariati (test)."
  }
}
```

---

## Note di design (TRM → MCP)

* **y (soluzione corrente)**: è lo **stato del repo** dopo l’ultima patch proposta dall’LLM.
* **z (ragionamento latente)**: `rationale` e `zNotes` (memoria breve) passano il contesto di come/ perché siamo arrivati a y. Questo replica l’idea TRM “mantieni soluzione e ragionamento” senza CoT verboso.
* **Deep supervision / ricorsione**: ogni `submitCandidate` è un **passo di miglioramento**; score/EMA sono la “supervisione profonda” che guida la convergenza.
* **ACT semplificato**: `shouldHalt` usa regole chiare (test passano + soglia, pazienza esaurita, maxSteps).
* **Less is more**: patch **piccole e mirate**, loop breve, segnali oggettivi (build/test/lint/bench). Niente doppio forward o training: sfruttiamo i tool esistenti del tuo stack.

---

## Suggerimenti pratici

* Abilita reporter **JSON** per i test (Jest/Vitest) così lo score è più accurato.
* Mantieni patch piccole per massimizzare il **delta informativo per step** (stile TRM).
* Usa `weights` per variare l’obiettivo (es. più peso a `perf` quando i test sono già verdi).
* Aggiungi `benchCmd` che ritorna **un numero** (es. ms totali) per normalizzare la metrica “lower-is-better”.
* Per TypeScript, usa `tsc --noEmit` nel `buildCmd` per catching veloce dei type errors.
* Integra un **pre-commit** locale con gli stessi comandi per coerenza.

Se vuoi, posso aggiungere:

* una **modalità patch AST-aware** (evita falsi negativi su `git apply`),
* un **aggregatore di copertura (coverage)** nel punteggio,
* dei **profili di policy** (bugfix vs perf tuning vs refactor) pronti all’uso.
