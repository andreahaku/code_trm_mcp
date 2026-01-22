import { execSync } from "child_process";
import type { PRReviewArgs, PRReviewResponse, ReviewComment, ReviewSummary, SecurityVulnerability, LargeFileIssue } from "../../types.js";
import { successResponse, errorResponse } from "./lib/response-utils.js";
import { analyzeContentSecurity } from "../../analyzer/security-analyzer.js";
import { analyzeContentQuality } from "../../analyzer/code-quality-analyzer.js";

/**
 * Handler for trm.reviewPR tool.
 * Performs detailed code review on a PR using either a GitHub URL or direct diff content.
 */
export async function handleReviewPR(args: PRReviewArgs): Promise<any> {
  try {
    let diffContent: string;
    let prInfo: { title?: string; url?: string } = {};

    // Get diff content from either URL or direct diff
    if (args.prUrl) {
      const result = await fetchPRDiff(args.prUrl);
      diffContent = result.diff;
      prInfo = result.info;
    } else if (args.diff) {
      diffContent = args.diff;
    } else if (args.files && args.files.length > 0) {
      // Generate diff from file contents
      diffContent = generateDiffFromFiles(args.files);
    } else {
      return errorResponse("Must provide either prUrl, diff, or files");
    }

    // Parse the diff to extract file changes
    const parsedDiff = parseDiff(diffContent);

    // Analyze each changed file
    const comments: ReviewComment[] = [];
    const issues: string[] = [];
    const suggestions: string[] = [];

    // Security and code quality analysis
    const allVulnerabilities: SecurityVulnerability[] = [];
    const allPositivePractices: string[] = [];
    const allLargeFiles: LargeFileIssue[] = [];
    const codeQualityRecommendations: string[] = [];

    for (const fileChange of parsedDiff) {
      // Analyze code style issues
      const analysis = await analyzeFileChange(fileChange, args.focus);
      comments.push(...analysis.comments);
      issues.push(...analysis.issues);
      suggestions.push(...analysis.suggestions);

      // Reconstruct file content from added lines for analysis
      const fileContent = fileChange.addedLines.map(l => l.content).join("\n");

      if (fileContent.length > 0) {
        // Security analysis on the added content
        const securityResult = analyzeContentSecurity(fileContent, fileChange.filePath);
        if (securityResult.vulnerabilities.length > 0) {
          // Renumber vulnerabilities to be unique across all files
          const startId = allVulnerabilities.length + 1;
          securityResult.vulnerabilities.forEach((v, i) => {
            v.id = startId + i;
          });
          allVulnerabilities.push(...securityResult.vulnerabilities);
        }
        if (securityResult.positivePractices.length > 0) {
          allPositivePractices.push(
            ...securityResult.positivePractices.map(p => `${p.title} in ${fileChange.filePath}`)
          );
        }

        // Code quality analysis - check if file would be large after changes
        // For modified files, we need to estimate the total size
        const estimatedTotalLines = fileChange.changeType === "added"
          ? fileChange.addedLines.length
          : fileChange.addedLines.length + 200; // Rough estimate for existing content

        if (estimatedTotalLines >= 300) {
          const qualityResult = analyzeContentQuality(fileContent, fileChange.filePath, 300);
          if (qualityResult) {
            qualityResult.id = allLargeFiles.length + 1;
            allLargeFiles.push(qualityResult);
          }
        }
      }
    }

    // Generate code quality recommendations
    if (allLargeFiles.length > 0) {
      codeQualityRecommendations.push(
        `${allLargeFiles.length} file(s) have significant size - consider code splitting`
      );
      const highSeverity = allLargeFiles.filter(f => f.severity === "high").length;
      if (highSeverity > 0) {
        codeQualityRecommendations.push(
          `${highSeverity} file(s) are very large (>1000 lines) - refactoring recommended before merging`
        );
      }
    }

    // Generate summary with security and code quality info
    const summary: ReviewSummary = generateSummary(
      parsedDiff,
      comments,
      issues,
      suggestions,
      allVulnerabilities,
      allLargeFiles
    );

    const response: PRReviewResponse = {
      summary,
      comments,
      issues,
      suggestions,
      prInfo,
      security: allVulnerabilities.length > 0 || allPositivePractices.length > 0 ? {
        vulnerabilities: allVulnerabilities,
        positives: allPositivePractices
      } : undefined,
      codeQuality: allLargeFiles.length > 0 ? {
        largeFiles: allLargeFiles,
        recommendations: codeQualityRecommendations
      } : undefined
    };

    return successResponse(response);
  } catch (err: unknown) {
    return errorResponse(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Fetch PR diff from GitHub URL
 */
async function fetchPRDiff(url: string): Promise<{ diff: string; info: { title?: string; url?: string } }> {
  try {
    // Extract owner, repo, and PR number from URL
    const match = url.match(/github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/);
    if (!match) {
      throw new Error("Invalid GitHub PR URL format. Expected: https://github.com/owner/repo/pull/123");
    }

    const [, owner, repo, prNumber] = match;

    // Use gh CLI if available, otherwise use curl to fetch diff
    let diff: string;
    let title: string | undefined;

    try {
      // Try using gh CLI first
      const prInfo = execSync(`gh pr view ${prNumber} --repo ${owner}/${repo} --json title,url`, {
        encoding: "utf-8",
        timeout: 30000
      });
      const parsed = JSON.parse(prInfo);
      title = parsed.title;

      diff = execSync(`gh pr diff ${prNumber} --repo ${owner}/${repo}`, {
        encoding: "utf-8",
        timeout: 30000
      });
    } catch {
      // Fallback to curl if gh CLI not available
      diff = execSync(`curl -L -H "Accept: application/vnd.github.v3.diff" https://github.com/${owner}/${repo}/pull/${prNumber}.diff`, {
        encoding: "utf-8",
        timeout: 30000
      });
    }

    return {
      diff,
      info: { title, url }
    };
  } catch (err: unknown) {
    throw new Error(`Failed to fetch PR diff: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Generate diff content from file list
 */
function generateDiffFromFiles(files: { path: string; content: string; originalContent?: string }[]): string {
  let diff = "";

  for (const file of files) {
    if (file.originalContent) {
      // Generate unified diff
      diff += `diff --git a/${file.path} b/${file.path}\n`;
      diff += `--- a/${file.path}\n`;
      diff += `+++ b/${file.path}\n`;

      const oldLines = file.originalContent.split("\n");
      const newLines = file.content.split("\n");

      // Simple line-by-line diff (could be improved with proper diff algorithm)
      diff += `@@ -1,${oldLines.length} +1,${newLines.length} @@\n`;

      const maxLen = Math.max(oldLines.length, newLines.length);
      for (let i = 0; i < maxLen; i++) {
        const oldLine = oldLines[i];
        const newLine = newLines[i];

        if (oldLine === newLine) {
          diff += ` ${oldLine || ""}\n`;
        } else {
          if (oldLine !== undefined) {
            diff += `-${oldLine}\n`;
          }
          if (newLine !== undefined) {
            diff += `+${newLine}\n`;
          }
        }
      }
    } else {
      // New file
      diff += `diff --git a/${file.path} b/${file.path}\n`;
      diff += `new file mode 100644\n`;
      diff += `--- /dev/null\n`;
      diff += `+++ b/${file.path}\n`;
      const lines = file.content.split("\n");
      diff += `@@ -0,0 +1,${lines.length} @@\n`;
      lines.forEach(line => {
        diff += `+${line}\n`;
      });
    }
  }

  return diff;
}

/**
 * Parse unified diff format
 */
function parseDiff(diff: string): ParsedFileChange[] {
  const fileChanges: ParsedFileChange[] = [];
  const fileBlocks = diff.split(/^diff --git /m).filter(block => block.trim());

  for (const block of fileBlocks) {
    const lines = block.split("\n");
    const firstLine = lines[0];

    // Extract file paths
    const match = firstLine.match(/a\/(.+?) b\/(.+?)$/);
    if (!match) continue;

    const [, oldPath, newPath] = match;
    const filePath = newPath;

    // Determine change type
    let changeType: "added" | "modified" | "deleted" = "modified";
    if (block.includes("new file mode")) {
      changeType = "added";
    } else if (block.includes("deleted file mode")) {
      changeType = "deleted";
    }

    // Extract added and removed lines
    const addedLines: { lineNum: number; content: string }[] = [];
    const removedLines: { lineNum: number; content: string }[] = [];

    let currentLineNum = 0;
    let inHunk = false;

    for (const line of lines) {
      // Parse hunk header
      const hunkMatch = line.match(/^@@ -\d+,?\d* \+(\d+),?\d* @@/);
      if (hunkMatch) {
        currentLineNum = parseInt(hunkMatch[1], 10);
        inHunk = true;
        continue;
      }

      if (!inHunk) continue;

      if (line.startsWith("+") && !line.startsWith("+++")) {
        addedLines.push({ lineNum: currentLineNum, content: line.slice(1) });
        currentLineNum++;
      } else if (line.startsWith("-") && !line.startsWith("---")) {
        removedLines.push({ lineNum: currentLineNum, content: line.slice(1) });
      } else if (line.startsWith(" ")) {
        currentLineNum++;
      }
    }

    fileChanges.push({
      filePath,
      changeType,
      addedLines,
      removedLines,
      fullDiff: block
    });
  }

  return fileChanges;
}

type ParsedFileChange = {
  filePath: string;
  changeType: "added" | "modified" | "deleted";
  addedLines: { lineNum: number; content: string }[];
  removedLines: { lineNum: number; content: string }[];
  fullDiff: string;
};

/**
 * Analyze a single file change
 */
async function analyzeFileChange(
  fileChange: ParsedFileChange,
  focus?: string[]
): Promise<{ comments: ReviewComment[]; issues: string[]; suggestions: string[] }> {
  const comments: ReviewComment[] = [];
  const issues: string[] = [];
  const suggestions: string[] = [];

  // Filter by focus areas if specified
  const shouldAnalyze = (category: string) => {
    if (!focus || focus.length === 0) return true;
    return focus.includes(category);
  };

  // Analyze added lines for common issues
  for (const { lineNum, content } of fileChange.addedLines) {
    // Check for console.log statements
    if (shouldAnalyze("logging") && /console\.(log|debug|warn|error)/.test(content)) {
      comments.push({
        file: fileChange.filePath,
        line: lineNum,
        severity: "warning",
        category: "logging",
        message: "Console statement found. Consider using a proper logging library.",
        suggestion: "Replace with structured logging (e.g., logger.info())"
      });
    }

    // Check for TODO/FIXME comments
    if (shouldAnalyze("todos") && /\/\/\s*(TODO|FIXME|HACK|XXX)/.test(content)) {
      comments.push({
        file: fileChange.filePath,
        line: lineNum,
        severity: "info",
        category: "todos",
        message: "TODO/FIXME comment found",
        suggestion: "Consider creating a tracking issue for this TODO"
      });
    }

    // Check for any types in TypeScript
    if (shouldAnalyze("type-safety") && /:\s*any\b/.test(content)) {
      comments.push({
        file: fileChange.filePath,
        line: lineNum,
        severity: "warning",
        category: "type-safety",
        message: "Usage of 'any' type reduces type safety",
        suggestion: "Use a more specific type or unknown instead"
      });
    }

    // Check for magic numbers
    if (shouldAnalyze("code-quality") && /\b\d{2,}\b/.test(content) && !/\/\/|\/\*|\*\/|"|'/.test(content)) {
      const hasConstOrEnum = /const|enum|readonly/.test(content);
      if (!hasConstOrEnum) {
        comments.push({
          file: fileChange.filePath,
          line: lineNum,
          severity: "info",
          category: "code-quality",
          message: "Potential magic number detected",
          suggestion: "Consider extracting to a named constant"
        });
      }
    }

    // Check for long lines
    if (shouldAnalyze("formatting") && content.length > 120) {
      comments.push({
        file: fileChange.filePath,
        line: lineNum,
        severity: "info",
        category: "formatting",
        message: `Line length (${content.length}) exceeds recommended 120 characters`,
        suggestion: "Consider breaking into multiple lines for readability"
      });
    }

    // Check for missing error handling in async functions
    if (shouldAnalyze("error-handling") && /async\s+function/.test(content)) {
      // Look ahead in added lines to check for try-catch
      const functionBody = fileChange.addedLines
        .filter(l => l.lineNum >= lineNum && l.lineNum <= lineNum + 20)
        .map(l => l.content)
        .join("\n");

      if (!/try\s*{/.test(functionBody)) {
        comments.push({
          file: fileChange.filePath,
          line: lineNum,
          severity: "warning",
          category: "error-handling",
          message: "Async function may be missing error handling",
          suggestion: "Consider wrapping async operations in try-catch"
        });
      }
    }
  }

  // Check for large changes
  if (shouldAnalyze("size") && fileChange.addedLines.length > 200) {
    issues.push(`${fileChange.filePath}: Large changeset (${fileChange.addedLines.length} lines added). Consider breaking into smaller PRs.`);
  }

  // Add suggestions based on file type
  if (fileChange.filePath.endsWith(".ts") || fileChange.filePath.endsWith(".tsx")) {
    if (shouldAnalyze("testing") && !fileChange.filePath.includes(".test.") && !fileChange.filePath.includes(".spec.")) {
      suggestions.push(`Consider adding tests for ${fileChange.filePath}`);
    }
  }

  return { comments, issues, suggestions };
}

/**
 * Generate review summary
 */
function generateSummary(
  fileChanges: ParsedFileChange[],
  comments: ReviewComment[],
  issues: string[],
  suggestions: string[],
  vulnerabilities: SecurityVulnerability[] = [],
  largeFiles: LargeFileIssue[] = []
): ReviewSummary {
  const filesChanged = fileChanges.length;
  const linesAdded = fileChanges.reduce((sum, fc) => sum + fc.addedLines.length, 0);
  const linesRemoved = fileChanges.reduce((sum, fc) => sum + fc.removedLines.length, 0);

  const criticalCount = comments.filter(c => c.severity === "error").length;
  const warningCount = comments.filter(c => c.severity === "warning").length;
  const infoCount = comments.filter(c => c.severity === "info").length;

  // Security summary
  const securityIssues = {
    critical: vulnerabilities.filter(v => v.severity === "critical").length,
    high: vulnerabilities.filter(v => v.severity === "high").length,
    medium: vulnerabilities.filter(v => v.severity === "medium").length,
    low: vulnerabilities.filter(v => v.severity === "low").length,
    total: vulnerabilities.length
  };

  // Code quality summary
  const codeQualityIssues = {
    largeFiles: largeFiles.length,
    highSeverity: largeFiles.filter(f => f.severity === "high").length
  };

  // Determine overall assessment (now includes security)
  let assessment: "approved" | "needs-changes" | "comments";
  if (criticalCount > 0 || issues.length > 0 || securityIssues.critical > 0 || securityIssues.high > 0) {
    assessment = "needs-changes";
  } else if (warningCount > 5 || securityIssues.medium > 2) {
    assessment = "needs-changes";
  } else if (comments.length > 0 || securityIssues.total > 0 || codeQualityIssues.largeFiles > 0) {
    assessment = "comments";
  } else {
    assessment = "approved";
  }

  const highlights: string[] = [];

  if (filesChanged > 10) {
    highlights.push(`Large PR affecting ${filesChanged} files`);
  }
  if (linesAdded > 500) {
    highlights.push(`Significant additions: ${linesAdded} lines`);
  }
  if (criticalCount > 0) {
    highlights.push(`${criticalCount} critical issue${criticalCount !== 1 ? 's' : ''} found`);
  }
  if (warningCount > 10) {
    highlights.push(`High warning count: ${warningCount} warnings`);
  }

  // Security highlights
  if (securityIssues.critical > 0) {
    highlights.push(`🔴 ${securityIssues.critical} CRITICAL security vulnerabilit${securityIssues.critical !== 1 ? 'ies' : 'y'}`);
  }
  if (securityIssues.high > 0) {
    highlights.push(`🟠 ${securityIssues.high} high severity security issue${securityIssues.high !== 1 ? 's' : ''}`);
  }
  if (securityIssues.medium > 0) {
    highlights.push(`🟡 ${securityIssues.medium} medium severity security issue${securityIssues.medium !== 1 ? 's' : ''}`);
  }

  // Code quality highlights
  if (codeQualityIssues.highSeverity > 0) {
    highlights.push(`📁 ${codeQualityIssues.highSeverity} very large file${codeQualityIssues.highSeverity !== 1 ? 's' : ''} (>1000 lines)`);
  } else if (codeQualityIssues.largeFiles > 0) {
    highlights.push(`📁 ${codeQualityIssues.largeFiles} large file${codeQualityIssues.largeFiles !== 1 ? 's' : ''} detected`);
  }

  return {
    filesChanged,
    linesAdded,
    linesRemoved,
    commentsCount: comments.length,
    criticalCount,
    warningCount,
    infoCount,
    assessment,
    highlights,
    securityIssues,
    codeQualityIssues
  };
}
