/**
 * Generate actionable fix candidates based on error analysis.
 * This module analyzes errors from evaluations and generates ready-to-apply candidates.
 */

import type {
  SessionState,
  EvalResult,
  FixSuggestion,
  ModifySubmission,
  EditOperation
} from "../types.js";
import { parseTypeScriptErrors } from "./ts-error-parser.js";

/**
 * Generate fix candidates based on the last evaluation result.
 * Returns actionable candidates that can be directly applied via submitCandidate.
 */
export async function generateFixCandidates(
  state: SessionState,
  lastEval: EvalResult
): Promise<FixSuggestion[]> {
  const suggestions: FixSuggestion[] = [];

  // Analyze build errors for TypeScript fixes
  if (!lastEval.okBuild) {
    const buildErrors = await analyzeBuildErrors(state, lastEval);
    suggestions.push(...buildErrors);
  }

  // Analyze test failures for potential fixes
  if (lastEval.tests && lastEval.tests.failed > 0) {
    const testFixes = await analyzeTestFailures(state, lastEval);
    suggestions.push(...testFixes);
  }

  // Analyze lint issues for auto-fixable problems
  if (!lastEval.okLint) {
    const lintFixes = await analyzeLintIssues(state, lastEval);
    suggestions.push(...lintFixes);
  }

  // Sort by priority: critical > high > medium > low
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  // Return top 3 suggestions
  return suggestions.slice(0, 3);
}

/**
 * Analyze TypeScript build errors and generate fix candidates.
 */
async function analyzeBuildErrors(
  state: SessionState,
  lastEval: EvalResult
): Promise<FixSuggestion[]> {
  const suggestions: FixSuggestion[] = [];

  // Extract error output from feedback
  const errorText = lastEval.feedback.join("\n");

  // Parse TypeScript errors
  const tsErrors = parseTypeScriptErrors(errorText);

  for (const tsError of tsErrors.slice(0, 2)) { // Max 2 TypeScript error fixes
    // Try to generate a fix based on error code
    const fix = generateTypeScriptFix(tsError.code, tsError.message, tsError.file, tsError.line);
    if (fix) {
      suggestions.push(fix);
    }
  }

  return suggestions;
}

/**
 * Generate TypeScript-specific fixes based on error codes.
 */
function generateTypeScriptFix(
  code: string,
  message: string,
  file: string,
  line: number
): FixSuggestion | null {
  // TS2304: Cannot find name - missing import
  if (code === "TS2304") {
    const nameMatch = message.match(/Cannot find name '(\w+)'/);
    if (nameMatch) {
      const missingName = nameMatch[1];
      return {
        priority: "high",
        issue: `Missing import for '${missingName}' in ${file}:${line}`,
        candidateToFix: {
          mode: "modify",
          changes: [{
            file,
            edits: [{
              type: "insertAfter",
              line: 1, // Insert after first line (typically file header comment)
              content: `import { ${missingName} } from "./types.js"; // TODO: Verify import path`
            }]
          }]
        },
        rationale: `Add missing import for '${missingName}' to fix TS2304 error`
      };
    }
  }

  // TS7006: Implicit 'any' type
  if (code === "TS7006") {
    const paramMatch = message.match(/Parameter '(\w+)' implicitly has an 'any' type/);
    if (paramMatch) {
      const param = paramMatch[1];
      return {
        priority: "medium",
        issue: `Implicit 'any' type for parameter '${param}' in ${file}:${line}`,
        candidateToFix: {
          mode: "modify",
          changes: [{
            file,
            edits: [{
              type: "replace",
              oldText: param,
              newText: `${param}: any // TODO: Add proper type`,
              all: false
            }]
          }]
        },
        rationale: `Add explicit 'any' type annotation for parameter '${param}'`
      };
    }
  }

  // TS2339: Property does not exist
  if (code === "TS2339" && message.includes("does not exist on type 'void'")) {
    return {
      priority: "high",
      issue: `Attempting to access property on void return value in ${file}:${line}`,
      candidateToFix: {
        mode: "modify",
        changes: [{
          file,
          edits: [{
            type: "replaceLine",
            line: line,
            content: "// TODO: Remove property access - function returns void and may throw instead"
          }]
        }]
      },
      rationale: "Function returns void (no return value). Remove property access and handle via try-catch."
    };
  }

  return null;
}

/**
 * Analyze test failures and generate potential fixes.
 */
async function analyzeTestFailures(
  state: SessionState,
  lastEval: EvalResult
): Promise<FixSuggestion[]> {
  const suggestions: FixSuggestion[] = [];

  // Look for common test failure patterns in feedback
  const errorText = lastEval.feedback.join("\n");

  // Pattern: Test expects X but got Y
  const expectMatch = errorText.match(/Expected:\s*(.+?)\s+Received:\s*(.+)/);
  if (expectMatch) {
    // This is a general pattern - would need file/line context to generate fix
    // For now, return a low-priority suggestion to review test logic
    suggestions.push({
      priority: "low",
      issue: `Test assertion mismatch detected`,
      candidateToFix: {
        mode: "modify",
        changes: [] // Empty - would need more context
      },
      rationale: "Review test expectations and implementation logic"
    });
  }

  return suggestions;
}

/**
 * Analyze lint issues and generate auto-fixable candidates.
 */
async function analyzeLintIssues(
  state: SessionState,
  lastEval: EvalResult
): Promise<FixSuggestion[]> {
  const suggestions: FixSuggestion[] = [];

  // Lint errors are typically style-related and harder to auto-fix
  // without detailed lint output parsing. Return empty for now.

  return suggestions;
}
