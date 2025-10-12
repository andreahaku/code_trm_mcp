/**
 * AI-powered suggestion generator for code improvements.
 * Combines evaluation results with static code analysis.
 */

import fs from "fs-extra";
import path from "path";
import type { Suggestion, SessionState, EvalResult } from "../types.js";
import { analyzeCodeFileEnhanced } from "./code-analyzer.js";

/**
 * Suggestion generation thresholds and limits
 */
const MAX_FILES_TO_ANALYZE = 5;
const MAX_LOCATIONS_TO_SHOW = 3;
const MISSING_DOCS_THRESHOLD = 3;
const MAGIC_NUMBERS_THRESHOLD = 5;
const IMPURE_FUNCTIONS_THRESHOLD = 2;
const PERFORMANCE_REGRESSION_THRESHOLD = 1.1; // 10% regression
const MAX_SUGGESTIONS_TO_RETURN = 5;

/**
 * Generate smart suggestions based on evaluation results and code analysis
 */
export async function generateSuggestions(
  state: SessionState,
  lastEval: EvalResult
): Promise<Suggestion[]> {
  const suggestions: Suggestion[] = [];

  // Analyze build/test/lint failures
  if (!lastEval.okBuild) {
    suggestions.push({
      priority: "critical",
      category: "code-quality",
      issue: "Build is failing",
      suggestedFix: "Fix compilation/type errors reported in feedback",
      autoFixable: false
    });
  }

  if (lastEval.tests && lastEval.tests.failed > 0) {
    suggestions.push({
      priority: "critical",
      category: "test-coverage",
      issue: `${lastEval.tests.failed} tests are failing`,
      suggestedFix: "Fix failing tests or update assertions",
      autoFixable: false
    });
  }

  if (!lastEval.okLint) {
    suggestions.push({
      priority: "high",
      category: "code-quality",
      issue: "Lint check is failing",
      suggestedFix: "Fix linting errors reported in feedback",
      autoFixable: true
    });
  }

  // Analyze source files for issues (sample a few key files)
  const repoPath = state.cfg.repoPath;
  const typescriptFiles = await fs.readdir(path.join(repoPath, "src")).catch(() => []);

  const filesToAnalyze = typescriptFiles
    .filter(f => f.endsWith(".ts") || f.endsWith(".tsx"))
    .slice(0, MAX_FILES_TO_ANALYZE);

  for (const file of filesToAnalyze) {
    const filePath = path.join(repoPath, "src", file);
    const issues = await analyzeCodeFileEnhanced(filePath);

    // Group by type
    const anyTypes = issues.filter(i => i.type === "any-type");
    const missingDocs = issues.filter(i => i.type === "missing-jsdoc");
    const magicNumbers = issues.filter(i => i.type === "magic-number");
    const largeModules = issues.filter(i => i.type === "large-module");
    const highComplexity = issues.filter(i => i.type === "high-complexity");
    const deepNesting = issues.filter(i => i.type === "deep-nesting");
    const impureFunctions = issues.filter(i => i.type === "impure-function");
    const hardToMock = issues.filter(i => i.type === "hard-to-mock");

    if (anyTypes.length > 0) {
      suggestions.push({
        priority: "high",
        category: "type-safety",
        issue: `${anyTypes.length} usage(s) of 'any' type detected`,
        locations: anyTypes.slice(0, MAX_LOCATIONS_TO_SHOW).map(i => ({
          file: `src/${file}`,
          line: i.line,
          snippet: i.context
        })),
        suggestedFix: "Replace 'any' with specific types or 'unknown' with type guards",
        autoFixable: true
      });
    }

    if (missingDocs.length > MISSING_DOCS_THRESHOLD) {
      suggestions.push({
        priority: "medium",
        category: "documentation",
        issue: `${missingDocs.length} functions in ${file} lack JSDoc`,
        suggestedFix: "Add JSDoc comments to exported functions",
        autoFixable: false
      });
    }

    if (magicNumbers.length > MAGIC_NUMBERS_THRESHOLD) {
      suggestions.push({
        priority: "low",
        category: "code-quality",
        issue: `${magicNumbers.length} magic numbers detected in ${file}`,
        suggestedFix: "Extract magic numbers to named constants",
        autoFixable: false
      });
    }

    // Maintainability: large modules
    if (largeModules.length > 0) {
      const moduleIssue = largeModules[0];
      suggestions.push({
        priority: "medium",
        category: "code-quality",
        issue: moduleIssue.message,
        locations: [{ file: `src/${file}`, line: moduleIssue.line }],
        suggestedFix: "Split into focused modules by grouping related functions. Consider domain-driven organization or separation by responsibility (e.g., utils, validation, processing).",
        autoFixable: false
      });
    }

    // Testability: high complexity
    if (highComplexity.length > 0) {
      suggestions.push({
        priority: "high",
        category: "code-quality",
        issue: `${highComplexity.length} function(s) in ${file} have high cyclomatic complexity`,
        locations: highComplexity.slice(0, MAX_LOCATIONS_TO_SHOW).map(i => ({
          file: `src/${file}`,
          line: i.line,
          snippet: i.message
        })),
        suggestedFix: "Reduce complexity by extracting conditional logic into separate functions with clear names. Use early returns, guard clauses, and strategy patterns.",
        autoFixable: false
      });
    }

    // Testability: deep nesting
    if (deepNesting.length > 0) {
      suggestions.push({
        priority: "high",
        category: "code-quality",
        issue: `${deepNesting.length} function(s) in ${file} have deep nesting (reduces testability)`,
        locations: deepNesting.slice(0, MAX_LOCATIONS_TO_SHOW).map(i => ({
          file: `src/${file}`,
          line: i.line,
          snippet: i.message
        })),
        suggestedFix: "Reduce nesting by extracting nested blocks into helper functions. Use early returns and guard clauses to flatten control flow.",
        autoFixable: false
      });
    }

    // Testability: impure functions
    if (impureFunctions.length > IMPURE_FUNCTIONS_THRESHOLD) {
      suggestions.push({
        priority: "medium",
        category: "code-quality",
        issue: `${impureFunctions.length} function(s) in ${file} have side effects but unclear naming`,
        locations: impureFunctions.slice(0, MAX_LOCATIONS_TO_SHOW).map(i => ({
          file: `src/${file}`,
          line: i.line,
          snippet: i.message
        })),
        suggestedFix: "Separate pure logic from side effects. Use command-query separation: pure functions for calculations, clearly named functions for side effects (e.g., executeX, saveX, logX).",
        autoFixable: false
      });
    }

    // Testability: hard to mock
    if (hardToMock.length > 0) {
      suggestions.push({
        priority: "medium",
        category: "code-quality",
        issue: `${hardToMock.length} function(s) in ${file} create dependencies internally (hard to test)`,
        locations: hardToMock.slice(0, MAX_LOCATIONS_TO_SHOW).map(i => ({
          file: `src/${file}`,
          line: i.line,
          snippet: i.message
        })),
        suggestedFix: "Use dependency injection: pass dependencies as function parameters or constructor arguments instead of instantiating them internally. This enables mocking in tests.",
        autoFixable: false
      });
    }
  }

  // Performance suggestions
  if (lastEval.perf && state.bestPerf && lastEval.perf.value > state.bestPerf * PERFORMANCE_REGRESSION_THRESHOLD) {
    suggestions.push({
      priority: "medium",
      category: "performance",
      issue: "Performance has regressed by >10%",
      suggestedFix: "Profile and optimize critical paths, or revert recent changes",
      autoFixable: false
    });
  }

  // Sort by priority
  const priorityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
  suggestions.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

  return suggestions.slice(0, MAX_SUGGESTIONS_TO_RETURN);
}
