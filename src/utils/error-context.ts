/**
 * Error context correlation utilities to help identify which changes caused failures.
 */

import type { EvalResult } from "../types.js";

export type IterationContext = {
  step: number;
  filesModified: string[];
  mode: string;
  success: boolean;
};

/**
 * Correlate build errors to recent file modifications.
 * Returns context about which iteration likely caused the issue.
 */
export function correlateErrorsToChanges(
  errorOutput: string,
  recentIterations: IterationContext[],
  currentStep: number
): { likelyCulprit?: IterationContext; lastSuccessful?: IterationContext; analysis: string[] } {
  const analysis: string[] = [];

  // Extract file references from error output
  const fileReferences: string[] = [];
  const filePatterns = [
    /([a-zA-Z0-9_\-/.]+\.(?:ts|js|tsx|jsx|py|java|go|rs)):(\d+):(\d+)/g, // file:line:col
    /at .+ \(([a-zA-Z0-9_\-/.]+\.(?:ts|js|tsx|jsx)):(\d+):(\d+)\)/g, // stack traces
    /Error in ([a-zA-Z0-9_\-/.]+\.(?:ts|js|tsx|jsx|py|java|go|rs))/g // "Error in file.ts"
  ];

  for (const pattern of filePatterns) {
    let match;
    while ((match = pattern.exec(errorOutput)) !== null) {
      fileReferences.push(match[1]);
    }
  }

  const uniqueFiles = [...new Set(fileReferences)];

  // Find the most recent iteration that modified any of the error files
  let likelyCulprit: IterationContext | undefined;
  let lastSuccessful: IterationContext | undefined;

  for (let i = recentIterations.length - 1; i >= 0; i--) {
    const iteration = recentIterations[i];

    if (iteration.success && !lastSuccessful) {
      lastSuccessful = iteration;
    }

    if (!likelyCulprit) {
      // Check if this iteration modified any files mentioned in errors
      const modifiedErrorFiles = iteration.filesModified.filter(f =>
        uniqueFiles.some(ef => ef.includes(f) || f.includes(ef))
      );

      if (modifiedErrorFiles.length > 0) {
        likelyCulprit = iteration;
        analysis.push(`🔍 Error likely caused by changes in iteration ${iteration.step}:`);
        for (const file of modifiedErrorFiles) {
          analysis.push(`   - ${file}`);
        }
      }
    }
  }

  // If we couldn't correlate to specific files, use the most recent failed iteration
  if (!likelyCulprit && recentIterations.length > 0) {
    const lastIteration = recentIterations[recentIterations.length - 1];
    if (!lastIteration.success) {
      likelyCulprit = lastIteration;
      analysis.push(`🔍 Error occurred after iteration ${lastIteration.step} changes`);
    }
  }

  // Add last successful build reference
  if (lastSuccessful) {
    analysis.push(`📍 Last successful build: iteration ${lastSuccessful.step} (score from history)`);
  }

  return { likelyCulprit, lastSuccessful, analysis };
}

/**
 * Extract actionable suggestions from error context.
 */
export function generateErrorSuggestions(
  errorType: "build" | "test" | "lint",
  likelyCulprit?: IterationContext
): string[] {
  const suggestions: string[] = [];

  if (likelyCulprit) {
    switch (errorType) {
      case "build":
        suggestions.push(
          `💡 Suggestion: Review changes in iteration ${likelyCulprit.step}. ` +
          `Check for type mismatches, missing imports, or syntax errors.`
        );
        break;
      case "test":
        suggestions.push(
          `💡 Suggestion: Changes in iteration ${likelyCulprit.step} may have broken test assumptions. ` +
          `Verify test fixtures and mocks are still valid.`
        );
        break;
      case "lint":
        suggestions.push(
          `💡 Suggestion: Lint errors from iteration ${likelyCulprit.step} changes. ` +
          `Run lint --fix if available, or manually address style issues.`
        );
        break;
    }

    // Mode-specific suggestions
    if (likelyCulprit.mode === "diff" || likelyCulprit.mode === "patch") {
      suggestions.push(
        `💡 Tip: Using '${likelyCulprit.mode}' mode can sometimes cause context mismatches. ` +
        `Consider 'modify' mode for more precise changes.`
      );
    }
  }

  return suggestions;
}

/**
 * Analyze if errors are cascading (one error causing multiple failures).
 */
export function detectCascadingErrors(
  history: Array<{ okBuild?: boolean; okLint?: boolean; tests?: { passed: number; total: number } }>
): { isCascading: boolean; pattern: string } | null {
  if (history.length < 3) return null;

  const recent = history.slice(-3);

  // Check if we went from all passing to progressively more failures
  const buildPattern = recent.map(h => h.okBuild);
  const testPattern = recent.map(h => h.tests ? h.tests.passed / h.tests.total : 1);

  // Cascading: build fails, then tests fail, then more tests fail
  if (
    buildPattern[0] === true &&
    buildPattern[1] === false &&
    buildPattern[2] === false
  ) {
    return {
      isCascading: true,
      pattern: "Build failure is likely causing all downstream test failures"
    };
  }

  // Check for degrading test pass rate
  if (testPattern.length === 3 &&
    testPattern[0] > 0.8 &&
    testPattern[1] < 0.5 &&
    testPattern[2] < testPattern[1]
  ) {
    return {
      isCascading: true,
      pattern: "Test failures are increasing - may indicate fundamental issue"
    };
  }

  return null;
}
