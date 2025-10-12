import type { SessionState } from "../../../types.js";
import { parseTypeScriptErrors, formatTypeScriptError, groupRelatedErrors } from "../../../utils/ts-error-parser.js";
import { correlateErrorsToChanges, generateErrorSuggestions } from "../../../utils/error-context.js";
import { diffHints } from "../../../utils/scoring.js";
import { MAX_HINT_LINES, MAX_FEEDBACK_ITEMS } from "../../../constants.js";
import type { EvaluationResults } from "./evaluation.js";

/**
 * Generates comprehensive feedback from evaluation results.
 * Includes error correlation, TypeScript error parsing, and actionable suggestions.
 */
export function generateFeedback(
  state: SessionState,
  evalResults: EvaluationResults,
  staleContextWarnings: string[]
): string[] {
  const feedback: string[] = [];
  const { build, test, lint, bench, testParsed } = evalResults;

  // Add stale context warnings first (high priority)
  feedback.push(...staleContextWarnings);

  // Build feedback with error correlation
  if (state.commandStatus.build !== "unavailable" && !build.ok) {
    feedback.push("Build failed – fix compilation/type errors.");

    // Correlate errors to recent changes
    const errorContext = correlateErrorsToChanges(
      build.stderr + "\n" + build.stdout,
      state.iterationContexts.slice(-5), // Last 5 iterations
      state.step
    );

    // Add correlation analysis
    feedback.push(...errorContext.analysis);

    // Add actionable suggestions
    const suggestions = generateErrorSuggestions("build", errorContext.likelyCulprit);
    feedback.push(...suggestions);

    // Parse TypeScript errors and add intelligent suggestions
    const tsErrors = parseTypeScriptErrors(build.stderr + "\n" + build.stdout);
    if (tsErrors.length > 0) {
      // Group related errors to reduce noise
      const grouped = groupRelatedErrors(tsErrors);

      // Add up to 3 most relevant errors with suggestions
      let errorCount = 0;
      for (const [, errors] of grouped) {
        if (errorCount >= 3) break;

        const firstError = errors[0];
        if (firstError.suggestion) {
          feedback.push(formatTypeScriptError(firstError));
          errorCount++;
        }
      }

      // Add count summary if there are more errors
      if (tsErrors.length > errorCount) {
        feedback.push(`   (${tsErrors.length - errorCount} more TypeScript errors)`);
      }
    }
  }

  // Test feedback
  if (state.cfg.testCmd && state.commandStatus.test !== "unavailable") {
    if (!testParsed) {
      feedback.push("Tests output not parsed – prefer JSON reporter or include summary lines.");
    } else {
      feedback.push(`Tests: ${testParsed.passed}/${testParsed.total} passed.`);
      if (testParsed.failed > 0) feedback.push(`There are ${testParsed.failed} failing tests.`);
    }
  }

  // Lint feedback
  if (state.cfg.lintCmd && state.commandStatus.lint !== "unavailable" && !lint.ok) {
    feedback.push("Lint failed – fix style/static-analysis issues.");
  }

  // Benchmark feedback
  if (state.cfg.benchCmd && state.commandStatus.bench !== "unavailable" && bench.ok) {
    feedback.push("Benchmark executed – try improving critical hot paths while keeping correctness.");
  }

  // Add hint lines from command output
  const hintLines = [
    ...(state.commandStatus.build !== "unavailable" ? diffHints(build.stderr, build.stdout) : []),
    ...(state.commandStatus.test !== "unavailable" ? diffHints(test.stderr, test.stdout) : []),
    ...(state.commandStatus.lint !== "unavailable" ? diffHints(lint.stderr, lint.stdout) : [])
  ].slice(0, MAX_HINT_LINES);

  // Deduplicate and limit feedback
  return [...new Set([...feedback, ...hintLines])].slice(0, MAX_FEEDBACK_ITEMS);
}

/**
 * Generates stale context warnings for files that were modified but not refreshed.
 */
export function generateStaleContextWarnings(
  state: SessionState,
  filesBeingModified: string[]
): string[] {
  const warnings: string[] = [];
  for (const file of filesBeingModified) {
    if (state.modifiedFiles.has(file)) {
      // File was modified before - check if context is fresh
      if (!state.fileSnapshots.has(file)) {
        warnings.push(
          `⚠️  ${file} was modified in step ${state.step - 1} but context not refreshed. Use trm.getFileContent to avoid patch failures.`
        );
      }
    }
  }
  return warnings;
}
