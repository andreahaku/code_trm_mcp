/**
 * Static code analysis for detecting quality issues.
 * Analyzes maintainability and testability metrics.
 */

import fs from "fs-extra";
import type { CodeIssue } from "../types.js";

/**
 * Analysis thresholds and constants
 */
const LONG_FUNCTION_THRESHOLD = 100;
const LARGE_MODULE_THRESHOLD = 500;
const ASYNC_LOOKAHEAD_LINES = 20;
const COMPLEXITY_THRESHOLD = 10;
const COMPLEXITY_WARNING_THRESHOLD = 15;
const NESTING_THRESHOLD = 4;
const MIN_FUNCTION_LENGTH_FOR_DI_CHECK = 10;

/**
 * Analyze code file for quality issues
 */
export async function analyzeCodeFile(filePath: string): Promise<CodeIssue[]> {
  const issues: CodeIssue[] = [];

  try {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    // Detect 'any' types
    lines.forEach((line, idx) => {
      if (line.match(/:\s*any\b/) && !line.trim().startsWith("//")) {
        issues.push({
          type: "any-type",
          severity: "warning",
          file: filePath,
          line: idx + 1,
          message: "Use of 'any' type reduces type safety",
          context: line.trim()
        });
      }
    });

    // Detect magic numbers
    lines.forEach((line, idx) => {
      const matches = line.match(/(?<![a-zA-Z0-9_])(\d+)(?![a-zA-Z0-9_])/g);
      if (matches) {
        // Filter out common non-magic numbers (0, 1, -1, 2, 100)
        const magicNumbers = matches.filter(n =>
          !["0", "1", "-1", "2", "100", "10", "1000"].includes(n)
        );
        if (magicNumbers.length > 0 && !line.trim().startsWith("//")) {
          issues.push({
            type: "magic-number",
            severity: "info",
            file: filePath,
            line: idx + 1,
            message: `Magic numbers found: ${magicNumbers.join(", ")}. Consider using named constants.`,
            context: line.trim()
          });
        }
      }
    });

    // Detect missing JSDoc on functions
    const functionRegex = /^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)/;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(functionRegex);
      if (match) {
        // Check if previous line has JSDoc comment
        const prevLine = i > 0 ? lines[i - 1].trim() : "";
        const hasDocs = prevLine.endsWith("*/") || prevLine.startsWith("/**");
        if (!hasDocs) {
          issues.push({
            type: "missing-jsdoc",
            severity: "info",
            file: filePath,
            line: i + 1,
            message: `Function '${match[1]}' lacks JSDoc documentation`
          });
        }
      }
    }

    // Detect long functions (> 100 lines)
    let functionStart = -1;
    let braceCount = 0;
    let functionName = "";

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(functionRegex);
      if (match && functionStart === -1) {
        functionStart = i;
        functionName = match[1];
        braceCount = 0;
      }

      if (functionStart !== -1) {
        braceCount += (line.match(/{/g) || []).length;
        braceCount -= (line.match(/}/g) || []).length;

        if (braceCount === 0 && line.includes("}")) {
          const length = i - functionStart + 1;
          if (length > LONG_FUNCTION_THRESHOLD) {
            issues.push({
              type: "long-function",
              severity: "warning",
              file: filePath,
              line: functionStart + 1,
              message: `Function '${functionName}' is ${length} lines long. Consider breaking it down.`
            });
          }
          functionStart = -1;
        }
      }
    }

    // Detect missing error handling in async functions
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].match(/async\s+function/) || lines[i].match(/async\s*\(/)) {
        let hasTryCatch = false;
        // Look ahead for try/catch within threshold
        for (let j = i; j < Math.min(i + ASYNC_LOOKAHEAD_LINES, lines.length); j++) {
          if (lines[j].includes("try {") || lines[j].includes("catch")) {
            hasTryCatch = true;
            break;
          }
        }
        if (!hasTryCatch && lines[i].includes("function")) {
          issues.push({
            type: "no-error-handling",
            severity: "warning",
            file: filePath,
            line: i + 1,
            message: "Async function may lack error handling (no try/catch found)"
          });
        }
      }
    }

  } catch (err) {
    // Ignore errors in analysis (file might not exist, etc.)
  }

  return issues;
}

/**
 * Calculate cyclomatic complexity for a function
 */
export function calculateCyclomaticComplexity(functionLines: string[]): number {
  const code = functionLines.join('\n');
  // Count decision points: if, for, while, case, &&, ||, ?, catch, ??, ?.
  const decisionPoints = (code.match(/\b(if|for|while|case|catch)\b|\&\&|\|\||\?(?!\?|\.)|\?\?|\?\./g) || []).length;
  return decisionPoints + 1; // Base complexity is 1
}

/**
 * Detect maximum nesting depth in a function
 */
export function detectMaxNesting(functionLines: string[]): number {
  let maxNesting = 0;
  let currentNesting = 0;

  for (const line of functionLines) {
    // Count opening braces
    const opens = (line.match(/{/g) || []).length;
    const closes = (line.match(/}/g) || []).length;

    currentNesting += opens;
    if (currentNesting > maxNesting) {
      maxNesting = currentNesting;
    }
    currentNesting -= closes;
  }

  return maxNesting;
}

/**
 * Enhanced code analysis with maintainability and testability checks
 */
export async function analyzeCodeFileEnhanced(filePath: string): Promise<CodeIssue[]> {
  const issues: CodeIssue[] = [];

  try {
    const content = await fs.readFile(filePath, "utf8");
    const lines = content.split(/\r?\n/);

    // 1. Check module size (file length)
    if (lines.length > LARGE_MODULE_THRESHOLD) {
      issues.push({
        type: "large-module",
        severity: "warning",
        file: filePath,
        line: 1,
        message: `File is ${lines.length} lines long. Consider splitting into focused modules for better maintainability and testability.`,
        context: "Large files are harder to test, understand, and maintain"
      });
    }

    // Run existing checks
    const basicIssues = await analyzeCodeFile(filePath);
    issues.push(...basicIssues);

    // 2. Enhanced function analysis with complexity and nesting
    const functionRegex = /^(?:export\s+)?(?:async\s+)?function\s+([a-zA-Z_][a-zA-Z0-9_]*)/;
    let functionStart = -1;
    let functionName = "";
    let braceCount = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = line.match(functionRegex);

      if (match && functionStart === -1) {
        functionStart = i;
        functionName = match[1];
        braceCount = 0;
      }

      if (functionStart !== -1) {
        braceCount += (line.match(/{/g) || []).length;
        braceCount -= (line.match(/}/g) || []).length;

        if (braceCount === 0 && line.includes("}")) {
          const functionLines = lines.slice(functionStart, i + 1);

          // Check cyclomatic complexity
          const complexity = calculateCyclomaticComplexity(functionLines);
          if (complexity > COMPLEXITY_THRESHOLD) {
            issues.push({
              type: "high-complexity",
              severity: complexity > COMPLEXITY_WARNING_THRESHOLD ? "warning" : "info",
              file: filePath,
              line: functionStart + 1,
              message: `Function '${functionName}' has cyclomatic complexity of ${complexity} (threshold: ${COMPLEXITY_THRESHOLD}). High complexity makes code harder to test and maintain.`,
              context: `Consider splitting into smaller functions with single responsibilities`
            });
          }

          // Check nesting depth
          const maxNesting = detectMaxNesting(functionLines);
          if (maxNesting > NESTING_THRESHOLD) {
            issues.push({
              type: "deep-nesting",
              severity: "warning",
              file: filePath,
              line: functionStart + 1,
              message: `Function '${functionName}' has nesting depth of ${maxNesting} (threshold: ${NESTING_THRESHOLD}). Deep nesting reduces testability.`,
              context: "Consider extracting nested logic into separate functions"
            });
          }

          // Check for side effects (impure functions)
          const hasSideEffects = functionLines.some(l =>
            l.match(/\b(fs\.|console\.|process\.|global\.|localStorage\.|sessionStorage\.|document\.|window\.)/i)
          );
          if (hasSideEffects && !functionName.match(/^(log|write|save|update|delete|execute|run|apply|init)/i)) {
            issues.push({
              type: "impure-function",
              severity: "info",
              file: filePath,
              line: functionStart + 1,
              message: `Function '${functionName}' has side effects but name doesn't indicate it. Impure functions are harder to test.`,
              context: "Consider separating pure logic from side effects, or use naming that indicates side effects"
            });
          }

          // Check for hard-to-mock patterns (direct instantiation)
          const hasDirectInstantiation = functionLines.some(l =>
            l.match(/new\s+[A-Z][a-zA-Z0-9_]*\(/) && !l.match(/new\s+(Map|Set|Array|Date|Error|Promise)\(/)
          );
          if (hasDirectInstantiation && functionLines.length > MIN_FUNCTION_LENGTH_FOR_DI_CHECK) {
            issues.push({
              type: "hard-to-mock",
              severity: "info",
              file: filePath,
              line: functionStart + 1,
              message: `Function '${functionName}' creates its own dependencies. Consider dependency injection for easier testing.`,
              context: "Pass dependencies as parameters instead of creating them internally"
            });
          }

          functionStart = -1;
        }
      }
    }

  } catch (err) {
    // Ignore errors in analysis
  }

  return issues;
}
