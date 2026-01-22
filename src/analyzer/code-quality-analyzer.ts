/**
 * Code quality analyzer for detecting large files and suggesting code splitting.
 * Focuses on maintainability, testability, and separation of concerns.
 */

import fs from "fs-extra";
import path from "path";
import type {
  FileComplexityMetrics,
  LargeFileIssue,
  SplitSuggestion,
  CodeQualitySeverity,
  CodeQualityAnalysisResponse
} from "../types.js";

// ============= CONFIGURATION =============

const DEFAULT_THRESHOLD = 500; // Lines threshold for large file warning

// Severity thresholds
const SEVERITY_THRESHOLDS = {
  high: 1000,    // >1000 lines = high severity
  medium: 700,   // >700 lines = medium severity
  low: 500       // >500 lines = low severity
};

// File extensions to analyze
const ANALYZABLE_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte", ".py", ".java", ".go", ".rs"
];

// Files/directories to skip
const SKIP_PATTERNS = [
  /node_modules/,
  /\.git/,
  /dist\//,
  /build\//,
  /coverage\//,
  /\.next\//,
  /\.nuxt\//,
  /vendor\//,
  /\.min\./,
  /\.bundle\./,
  /\.generated\./,
  /\.d\.ts$/,
  /package-lock\.json/,
  /yarn\.lock/,
  /pnpm-lock\.yaml/
];

// ============= PATTERN DETECTION =============

// Patterns for detecting code constructs
const PATTERNS = {
  // Classes
  class: /^\s*(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/,

  // Functions (various styles)
  functionDeclaration: /^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
  arrowFunction: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\([^)]*\)\s*(?::\s*[^=]+)?\s*=>/,
  methodDefinition: /^\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{/,

  // Exports
  namedExport: /^\s*export\s+(?:const|let|var|function|class|type|interface|enum)\s+(\w+)/,
  defaultExport: /^\s*export\s+default/,
  reExport: /^\s*export\s+\{[^}]+\}\s+from/,
  exportStatement: /^\s*export\s+\{/,

  // Imports
  importStatement: /^\s*import\s+/,

  // Comments
  singleLineComment: /^\s*\/\//,
  multiLineCommentStart: /^\s*\/\*/,
  multiLineCommentEnd: /\*\/\s*$/,

  // Type definitions
  typeDefinition: /^\s*(?:export\s+)?(?:type|interface)\s+(\w+)/,

  // Constants (potential extraction candidates)
  constObject: /^\s*(?:export\s+)?const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*\{/,
  constArray: /^\s*(?:export\s+)?const\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*\[/,

  // Blank line
  blankLine: /^\s*$/
};

// ============= ANALYSIS FUNCTIONS =============

/**
 * Recursively get all analyzable files in a directory
 */
async function getAnalyzableFiles(
  dirPath: string,
  include?: string[],
  exclude?: string[]
): Promise<string[]> {
  const files: string[] = [];

  async function walk(currentPath: string): Promise<void> {
    try {
      const entries = await fs.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        const relativePath = path.relative(dirPath, fullPath);

        // Skip patterns
        if (SKIP_PATTERNS.some(pattern => pattern.test(fullPath))) {
          continue;
        }

        // User exclude patterns
        if (exclude?.some(pattern => {
          const regex = new RegExp(pattern.replace(/\*/g, ".*"));
          return regex.test(relativePath);
        })) {
          continue;
        }

        if (entry.isDirectory()) {
          await walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();

          // Check include patterns
          if (include?.length) {
            const matches = include.some(pattern => {
              const regex = new RegExp(pattern.replace(/\*/g, ".*"));
              return regex.test(relativePath);
            });
            if (!matches) continue;
          }

          if (ANALYZABLE_EXTENSIONS.includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  await walk(dirPath);
  return files;
}

/**
 * Analyze file complexity metrics
 */
function analyzeFileComplexity(content: string): FileComplexityMetrics {
  const lines = content.split(/\r?\n/);

  let codeLines = 0;
  let commentLines = 0;
  let blankLines = 0;
  let inMultiLineComment = false;

  const classes: string[] = [];
  const functions: string[] = [];
  const exports: string[] = [];
  let imports = 0;

  const functionLengths: number[] = [];
  let currentFunctionStart = -1;
  let braceDepth = 0;
  let maxNestingDepth = 0;
  let currentNestingDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmedLine = line.trim();

    // Track blank lines
    if (PATTERNS.blankLine.test(line)) {
      blankLines++;
      continue;
    }

    // Track comments
    if (inMultiLineComment) {
      commentLines++;
      if (PATTERNS.multiLineCommentEnd.test(line)) {
        inMultiLineComment = false;
      }
      continue;
    }

    if (PATTERNS.multiLineCommentStart.test(line)) {
      commentLines++;
      if (!PATTERNS.multiLineCommentEnd.test(line)) {
        inMultiLineComment = true;
      }
      continue;
    }

    if (PATTERNS.singleLineComment.test(line)) {
      commentLines++;
      continue;
    }

    // Count as code line
    codeLines++;

    // Track imports
    if (PATTERNS.importStatement.test(line)) {
      imports++;
    }

    // Track classes
    const classMatch = line.match(PATTERNS.class);
    if (classMatch) {
      classes.push(classMatch[1]);
    }

    // Track functions
    const funcDeclMatch = line.match(PATTERNS.functionDeclaration);
    if (funcDeclMatch) {
      functions.push(funcDeclMatch[1]);
      if (currentFunctionStart === -1) {
        currentFunctionStart = i;
      }
    }

    const arrowMatch = line.match(PATTERNS.arrowFunction);
    if (arrowMatch) {
      functions.push(arrowMatch[1]);
    }

    // Track exports
    const namedExportMatch = line.match(PATTERNS.namedExport);
    if (namedExportMatch) {
      exports.push(namedExportMatch[1]);
    } else if (PATTERNS.defaultExport.test(line)) {
      exports.push("default");
    } else if (PATTERNS.reExport.test(line) || PATTERNS.exportStatement.test(line)) {
      exports.push("re-export");
    }

    // Track nesting depth via braces
    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;

    braceDepth += openBraces - closeBraces;
    currentNestingDepth = Math.max(0, braceDepth);
    maxNestingDepth = Math.max(maxNestingDepth, currentNestingDepth);

    // Track function lengths
    if (currentFunctionStart !== -1 && braceDepth === 0) {
      functionLengths.push(i - currentFunctionStart + 1);
      currentFunctionStart = -1;
    }
  }

  const maxFunctionLength = functionLengths.length > 0 ? Math.max(...functionLengths) : 0;
  const avgFunctionLength = functionLengths.length > 0
    ? Math.round(functionLengths.reduce((a, b) => a + b, 0) / functionLengths.length)
    : 0;

  return {
    lineCount: lines.length,
    codeLines,
    commentLines,
    blankLines,
    classes: classes.length,
    functions: functions.length,
    exports: exports.length,
    imports,
    maxFunctionLength,
    avgFunctionLength,
    nestingDepth: maxNestingDepth
  };
}

/**
 * Extract specific items from file for split suggestions
 */
function extractItems(content: string): {
  classes: Array<{ name: string; lineStart: number; lineEnd: number }>;
  largeFunctions: Array<{ name: string; lineStart: number; length: number }>;
  typeDefinitions: string[];
  constants: string[];
} {
  const lines = content.split(/\r?\n/);
  const classes: Array<{ name: string; lineStart: number; lineEnd: number }> = [];
  const largeFunctions: Array<{ name: string; lineStart: number; length: number }> = [];
  const typeDefinitions: string[] = [];
  const constants: string[] = [];

  let currentClass: { name: string; lineStart: number; braceDepth: number } | null = null;
  let currentFunction: { name: string; lineStart: number; braceDepth: number } | null = null;
  let braceDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Track classes
    const classMatch = line.match(PATTERNS.class);
    if (classMatch && !currentClass) {
      currentClass = { name: classMatch[1], lineStart: i + 1, braceDepth };
    }

    // Track functions (only top-level, > 50 lines)
    const funcMatch = line.match(PATTERNS.functionDeclaration);
    if (funcMatch && braceDepth === 0 && !currentFunction) {
      currentFunction = { name: funcMatch[1], lineStart: i + 1, braceDepth };
    }

    // Track type definitions
    const typeMatch = line.match(PATTERNS.typeDefinition);
    if (typeMatch) {
      typeDefinitions.push(typeMatch[1]);
    }

    // Track large constants
    const constObjMatch = line.match(PATTERNS.constObject);
    if (constObjMatch) {
      constants.push(constObjMatch[1]);
    }
    const constArrMatch = line.match(PATTERNS.constArray);
    if (constArrMatch) {
      constants.push(constArrMatch[1]);
    }

    // Track brace depth
    const openBraces = (line.match(/\{/g) || []).length;
    const closeBraces = (line.match(/\}/g) || []).length;
    braceDepth += openBraces - closeBraces;

    // End of class
    if (currentClass && braceDepth <= currentClass.braceDepth) {
      classes.push({
        name: currentClass.name,
        lineStart: currentClass.lineStart,
        lineEnd: i + 1
      });
      currentClass = null;
    }

    // End of function
    if (currentFunction && braceDepth <= currentFunction.braceDepth) {
      const length = i + 1 - currentFunction.lineStart;
      if (length > 50) {  // Only track large functions
        largeFunctions.push({
          name: currentFunction.name,
          lineStart: currentFunction.lineStart,
          length
        });
      }
      currentFunction = null;
    }
  }

  return { classes, largeFunctions, typeDefinitions, constants };
}

/**
 * Generate split suggestions based on file analysis
 */
function generateSplitSuggestions(
  metrics: FileComplexityMetrics,
  items: ReturnType<typeof extractItems>,
  fileName: string
): SplitSuggestion[] {
  const suggestions: SplitSuggestion[] = [];
  const baseName = path.basename(fileName, path.extname(fileName));

  // Suggest extracting multiple classes
  if (items.classes.length > 1) {
    suggestions.push({
      type: "extract-class",
      description: `Extract ${items.classes.length - 1} class(es) to separate files for single responsibility`,
      targetItems: items.classes.slice(1).map(c => c.name),
      estimatedLines: items.classes.slice(1).reduce((sum, c) => sum + (c.lineEnd - c.lineStart), 0)
    });
  }

  // Suggest extracting large functions
  if (items.largeFunctions.length > 0) {
    const totalLines = items.largeFunctions.reduce((sum, f) => sum + f.length, 0);
    suggestions.push({
      type: "extract-functions",
      description: `Extract ${items.largeFunctions.length} large function(s) (>50 lines) to a utils or helpers module`,
      targetItems: items.largeFunctions.map(f => `${f.name} (${f.length} lines)`),
      estimatedLines: totalLines
    });
  }

  // Suggest extracting type definitions
  if (items.typeDefinitions.length >= 3) {
    suggestions.push({
      type: "extract-types",
      description: `Move ${items.typeDefinitions.length} type/interface definitions to a separate types file`,
      targetItems: items.typeDefinitions.slice(0, 5),
      estimatedLines: items.typeDefinitions.length * 5 // Rough estimate
    });
  }

  // Suggest extracting constants
  if (items.constants.length >= 3) {
    suggestions.push({
      type: "extract-constants",
      description: `Extract ${items.constants.length} constant definitions to a constants or config file`,
      targetItems: items.constants.slice(0, 5),
      estimatedLines: items.constants.length * 10 // Rough estimate
    });
  }

  // Suggest module extraction based on high export count
  if (metrics.exports > 10 && items.classes.length <= 1) {
    suggestions.push({
      type: "extract-module",
      description: `Consider splitting ${metrics.exports} exports into focused sub-modules by domain or feature`,
      estimatedLines: Math.round(metrics.codeLines / 3)
    });
  }

  // Generic suggestion if no specific ones apply
  if (suggestions.length === 0 && metrics.codeLines > 500) {
    suggestions.push({
      type: "extract-module",
      description: `Consider breaking down ${baseName} by logical concerns or feature boundaries`,
      estimatedLines: Math.round(metrics.codeLines / 2)
    });
  }

  return suggestions;
}

/**
 * Determine severity based on line count
 */
function determineSeverity(lineCount: number, threshold: number): CodeQualitySeverity {
  if (lineCount >= SEVERITY_THRESHOLDS.high) return "high";
  if (lineCount >= SEVERITY_THRESHOLDS.medium) return "medium";
  if (lineCount >= threshold) return "low";
  return "low";
}

/**
 * Generate impact descriptions based on metrics
 */
function generateImpact(metrics: FileComplexityMetrics): string[] {
  const impact: string[] = [];

  if (metrics.lineCount > 800) {
    impact.push("Difficult to navigate and understand the full context");
  }
  if (metrics.lineCount > 500) {
    impact.push("Harder to test individual components in isolation");
  }
  if (metrics.classes > 1) {
    impact.push("Multiple classes violate single responsibility principle");
  }
  if (metrics.functions > 20) {
    impact.push("High function count increases cognitive load");
  }
  if (metrics.nestingDepth > 5) {
    impact.push("Deep nesting makes code harder to follow and debug");
  }
  if (metrics.maxFunctionLength > 100) {
    impact.push("Very long functions are hard to test and maintain");
  }
  if (metrics.imports > 15) {
    impact.push("Many imports suggest the file has too many responsibilities");
  }
  if (metrics.exports > 10) {
    impact.push("Many exports indicate the module might be doing too much");
  }

  // Add general impacts if none specific
  if (impact.length === 0) {
    impact.push("Large files are harder to review in pull requests");
    impact.push("Changes have higher risk of merge conflicts");
  }

  return impact;
}

/**
 * Analyze a single file for size and complexity
 */
async function analyzeFile(
  filePath: string,
  basePath: string,
  threshold: number
): Promise<LargeFileIssue | null> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const metrics = analyzeFileComplexity(content);

    // Skip files under threshold
    if (metrics.lineCount < threshold) {
      return null;
    }

    const relativePath = path.relative(basePath, filePath);
    const severity = determineSeverity(metrics.lineCount, threshold);
    const items = extractItems(content);
    const suggestions = generateSplitSuggestions(metrics, items, filePath);
    const impact = generateImpact(metrics);

    return {
      id: 0, // Will be assigned later
      file: relativePath,
      severity,
      metrics,
      issue: `File has ${metrics.lineCount} lines (${metrics.codeLines} code, ${metrics.commentLines} comments, ${metrics.blankLines} blank)`,
      impact,
      suggestions
    };

  } catch {
    return null;
  }
}

// ============= MAIN EXPORT =============

/**
 * Perform code quality analysis focusing on file size and complexity
 */
export async function analyzeCodeQuality(
  targetPath: string,
  options?: {
    threshold?: number;
    include?: string[];
    exclude?: string[];
  }
): Promise<CodeQualityAnalysisResponse> {
  const basePath = path.resolve(targetPath);
  const threshold = options?.threshold ?? DEFAULT_THRESHOLD;

  // Get all analyzable files
  const files = await getAnalyzableFiles(basePath, options?.include, options?.exclude);

  // Analyze each file
  const largeFiles: LargeFileIssue[] = [];
  let totalCodeLines = 0;
  let maxFileSize = 0;
  const fileSizes: number[] = [];

  for (const file of files) {
    const content = await fs.readFile(file, "utf8").catch(() => "");
    const lineCount = content.split(/\r?\n/).length;
    fileSizes.push(lineCount);
    totalCodeLines += lineCount;
    maxFileSize = Math.max(maxFileSize, lineCount);

    const issue = await analyzeFile(file, basePath, threshold);
    if (issue) {
      largeFiles.push(issue);
    }
  }

  // Assign IDs
  largeFiles.forEach((f, i) => f.id = i + 1);

  // Sort by severity and line count
  const severityOrder = { high: 0, medium: 1, low: 2 };
  largeFiles.sort((a, b) => {
    const severityDiff = severityOrder[a.severity] - severityOrder[b.severity];
    if (severityDiff !== 0) return severityDiff;
    return b.metrics.lineCount - a.metrics.lineCount;
  });

  // Calculate summary
  const summary = {
    high: largeFiles.filter(f => f.severity === "high").length,
    medium: largeFiles.filter(f => f.severity === "medium").length,
    low: largeFiles.filter(f => f.severity === "low").length,
    total: largeFiles.length
  };

  // Generate recommendations
  const recommendations: string[] = [];

  if (summary.high > 0) {
    recommendations.push(
      `Prioritize splitting ${summary.high} file(s) over 1000 lines - these are critical maintainability risks`
    );
  }

  if (summary.medium > 0) {
    recommendations.push(
      `Plan refactoring for ${summary.medium} file(s) between 700-1000 lines in upcoming sprints`
    );
  }

  if (summary.total > 5) {
    recommendations.push(
      "Consider establishing a team guideline for maximum file size (recommended: 300-500 lines)"
    );
  }

  const avgFileSize = files.length > 0 ? Math.round(totalCodeLines / files.length) : 0;
  if (avgFileSize > 200) {
    recommendations.push(
      `Average file size is ${avgFileSize} lines - consider more granular module boundaries`
    );
  }

  if (largeFiles.some(f => f.metrics.classes > 1)) {
    recommendations.push(
      "Extract multiple classes per file into separate files following single responsibility principle"
    );
  }

  if (largeFiles.some(f => f.metrics.maxFunctionLength > 100)) {
    recommendations.push(
      "Break down functions over 100 lines into smaller, focused helper functions"
    );
  }

  if (recommendations.length === 0 && summary.total > 0) {
    recommendations.push(
      "Review large files during code reviews and gradually refactor as changes are needed"
    );
  }

  return {
    largeFiles,
    metrics: {
      totalFilesAnalyzed: files.length,
      filesOverThreshold: largeFiles.length,
      avgFileSize,
      maxFileSize,
      totalCodeLines
    },
    summary,
    recommendations
  };
}
