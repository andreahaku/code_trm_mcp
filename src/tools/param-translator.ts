/**
 * Parameter translator for ultra-optimized schema names.
 * Maps short property names to original names used by handlers.
 */

type ParamMap = Record<string, any>;

/**
 * Property name mappings (short → original)
 */
const PROP_MAP: Record<string, string> = {
  // Session
  sid: "sessionId",
  repo: "repoPath",
  build: "buildCmd",
  test: "testCmd",
  lint: "lintCmd",
  bench: "benchCmd",
  timeout: "timeoutSec",
  ema: "emaAlpha",
  notes: "zNotes",

  // Candidate
  reason: "rationale",

  // Checkpoint
  cid: "checkpointId",
  desc: "description",

  // File lines
  start: "startLine",
  end: "endLine",

  // PR Review
  url: "prUrl",
  orig: "originalContent"
};

/**
 * Nested property mappings for halt config
 */
const HALT_MAP: Record<string, string> = {
  max: "maxSteps",
  threshold: "passThreshold",
  patience: "patienceNoImprove",
  min: "minSteps"
};

/**
 * Recursively translate property names from short to original
 */
function translateObject(obj: ParamMap): ParamMap {
  const result: ParamMap = {};

  for (const [key, value] of Object.entries(obj)) {
    // Translate the key
    const newKey = PROP_MAP[key] || key;

    // Handle nested objects
    if (value && typeof value === "object" && !Array.isArray(value)) {
      // Special handling for halt config
      if (key === "halt") {
        result[newKey] = translateHaltConfig(value);
      } else {
        result[newKey] = translateObject(value);
      }
    } else {
      result[newKey] = value;
    }
  }

  return result;
}

/**
 * Translate halt configuration object
 */
function translateHaltConfig(halt: ParamMap): ParamMap {
  const result: ParamMap = {};

  for (const [key, value] of Object.entries(halt)) {
    const newKey = HALT_MAP[key] || key;
    result[newKey] = value;
  }

  return result;
}

/**
 * Translate parameters from ultra-optimized schema to original format
 */
export function translateParams(params: any): any {
  if (!params || typeof params !== "object") {
    return params;
  }

  return translateObject(params);
}
