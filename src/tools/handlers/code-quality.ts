/**
 * Handler for trm.codeQuality tool.
 * Analyzes codebase for large files and suggests code splitting strategies.
 */

import path from "path";
import fs from "fs-extra";
import type { CodeQualityAnalysisArgs, CodeQualityAnalysisResponse } from "../../types.js";
import { analyzeCodeQuality } from "../../analyzer/code-quality-analyzer.js";
import { successResponse, errorResponse, validationErrorResponse } from "./lib/response-utils.js";

/**
 * Format the code quality analysis response for display
 */
function formatCodeQualityReport(response: CodeQualityAnalysisResponse, threshold: number): string {
  const lines: string[] = [];

  // === HEADER ===
  lines.push("## Code Quality Analysis - Large File Detection\n");
  lines.push(`**Threshold:** ${threshold} lines\n`);

  // === SUMMARY TABLE ===
  lines.push("### Summary\n");
  lines.push("| Severity | Count | Line Range |");
  lines.push("|----------|-------|------------|");

  if (response.summary.high > 0) {
    lines.push(`| HIGH | ${response.summary.high} | >1000 lines |`);
  }
  if (response.summary.medium > 0) {
    lines.push(`| Medium | ${response.summary.medium} | 700-1000 lines |`);
  }
  if (response.summary.low > 0) {
    lines.push(`| Low | ${response.summary.low} | ${threshold}-700 lines |`);
  }

  if (response.summary.total === 0) {
    lines.push(`| - | 0 | No files over ${threshold} lines |`);
  }

  lines.push(`\n**Total files over threshold:** ${response.summary.total} of ${response.metrics.totalFilesAnalyzed} analyzed\n`);

  // === METRICS ===
  lines.push("### Codebase Metrics\n");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Total Files Analyzed | ${response.metrics.totalFilesAnalyzed} |`);
  lines.push(`| Files Over Threshold | ${response.metrics.filesOverThreshold} |`);
  lines.push(`| Average File Size | ${response.metrics.avgFileSize} lines |`);
  lines.push(`| Largest File | ${response.metrics.maxFileSize} lines |`);
  lines.push(`| Total Code Lines | ${response.metrics.totalCodeLines.toLocaleString()} |`);

  // === LARGE FILES ===
  if (response.largeFiles.length > 0) {
    lines.push("\n---\n### Large Files Requiring Attention\n");

    for (const file of response.largeFiles) {
      const severityBadge = file.severity === "high" ? "🔴" : file.severity === "medium" ? "🟠" : "🟡";

      lines.push(`#### ${file.id}. ${severityBadge} \`${file.file}\``);
      lines.push(`**Severity:** ${file.severity.toUpperCase()} | **Lines:** ${file.metrics.lineCount}\n`);

      // File metrics
      lines.push("**File Composition:**");
      lines.push(`- Code: ${file.metrics.codeLines} lines | Comments: ${file.metrics.commentLines} | Blank: ${file.metrics.blankLines}`);
      lines.push(`- Classes: ${file.metrics.classes} | Functions: ${file.metrics.functions} | Exports: ${file.metrics.exports} | Imports: ${file.metrics.imports}`);

      if (file.metrics.maxFunctionLength > 50) {
        lines.push(`- Longest function: ${file.metrics.maxFunctionLength} lines | Avg function: ${file.metrics.avgFunctionLength} lines`);
      }
      if (file.metrics.nestingDepth > 3) {
        lines.push(`- Max nesting depth: ${file.metrics.nestingDepth} levels`);
      }

      // Impact
      if (file.impact.length > 0) {
        lines.push("\n**Impact:**");
        file.impact.forEach(i => lines.push(`- ${i}`));
      }

      // Suggestions
      if (file.suggestions.length > 0) {
        lines.push("\n**Suggested Splits:**");
        for (const suggestion of file.suggestions) {
          const typeLabel = {
            "extract-class": "📦 Extract Class",
            "extract-functions": "⚡ Extract Functions",
            "extract-module": "📁 Split Module",
            "extract-constants": "🔧 Extract Constants",
            "extract-types": "📝 Extract Types"
          }[suggestion.type] || suggestion.type;

          lines.push(`- **${typeLabel}:** ${suggestion.description}`);

          if (suggestion.targetItems && suggestion.targetItems.length > 0) {
            const itemList = suggestion.targetItems.slice(0, 5).join(", ");
            const more = suggestion.targetItems.length > 5 ? ` (+${suggestion.targetItems.length - 5} more)` : "";
            lines.push(`  - Items: \`${itemList}\`${more}`);
          }

          if (suggestion.estimatedLines) {
            lines.push(`  - Estimated reduction: ~${suggestion.estimatedLines} lines`);
          }
        }
      }

      lines.push("");
    }
  }

  // === RECOMMENDATIONS ===
  if (response.recommendations.length > 0) {
    lines.push("---\n### Recommendations\n");
    response.recommendations.forEach((rec, idx) => {
      lines.push(`${idx + 1}. ${rec}`);
    });
  }

  // === BEST PRACTICES ===
  lines.push("\n---\n### Best Practices for File Size\n");
  lines.push("| Guideline | Recommended | Why |");
  lines.push("|-----------|-------------|-----|");
  lines.push("| Max file size | 300-500 lines | Easier to review and understand |");
  lines.push("| Max function size | 50-100 lines | Testable, single responsibility |");
  lines.push("| Max classes per file | 1 | Clear ownership and imports |");
  lines.push("| Max nesting depth | 3-4 levels | Reduces cognitive complexity |");

  return lines.join("\n");
}

/**
 * Handler for code quality analysis tool
 */
export async function handleCodeQualityAnalysis(args: CodeQualityAnalysisArgs): Promise<any> {
  try {
    // Validate path
    if (!args.path) {
      return validationErrorResponse("Path is required for code quality analysis");
    }

    const targetPath = path.resolve(args.path);

    // Check if path exists
    const exists = await fs.pathExists(targetPath);
    if (!exists) {
      return validationErrorResponse(`Path does not exist: ${targetPath}`);
    }

    // Check if it's a directory
    const stat = await fs.stat(targetPath);
    if (!stat.isDirectory()) {
      return validationErrorResponse("Path must be a directory");
    }

    const threshold = args.threshold ?? 500;

    // Perform analysis
    const response = await analyzeCodeQuality(targetPath, {
      threshold,
      include: args.include,
      exclude: args.exclude
    });

    // Format the report
    const formattedReport = formatCodeQualityReport(response, threshold);

    // Return both formatted report and structured data
    return {
      content: [{
        type: "text",
        text: formattedReport + "\n\n---\n\n```json\n" + JSON.stringify({
          summary: response.summary,
          metrics: response.metrics,
          largeFilesCount: response.largeFiles.length,
          threshold
        }, null, 2) + "\n```"
      }]
    };

  } catch (err: unknown) {
    return errorResponse(err instanceof Error ? err.message : String(err));
  }
}
