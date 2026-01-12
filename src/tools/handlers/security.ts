/**
 * Handler for trm.security tool.
 * Performs comprehensive security analysis on a codebase.
 */

import path from "path";
import fs from "fs-extra";
import type { SecurityAnalysisArgs, SecurityAnalysisResponse, SecuritySeverity } from "../../types.js";
import { analyzeSecurityComprehensive } from "../../analyzer/security-analyzer.js";
import { successResponse, errorResponse, validationErrorResponse } from "./lib/response-utils.js";

/**
 * Format the security analysis response for display
 */
function formatSecurityReport(response: SecurityAnalysisResponse): string {
  const lines: string[] = [];

  // === SUMMARY TABLE ===
  lines.push("## Security Analysis Summary\n");
  lines.push("| Severity | Count | Action Required |");
  lines.push("|----------|-------|-----------------|");

  if (response.summary.critical > 0) {
    lines.push(`| CRITICAL | ${response.summary.critical} | Immediate remediation |`);
  }
  if (response.summary.high > 0) {
    lines.push(`| High | ${response.summary.high} | Immediate remediation |`);
  }
  if (response.summary.medium > 0) {
    lines.push(`| Medium | ${response.summary.medium} | Address in next sprint |`);
  }
  if (response.summary.low > 0) {
    lines.push(`| Low | ${response.summary.low} | Add to backlog |`);
  }

  lines.push(`\n**Total Issues:** ${response.summary.total}\n`);

  // === POSITIVE PRACTICES ===
  if (response.positivePractices.length > 0) {
    lines.push("---\n## Positive Security Practices Observed\n");
    response.positivePractices.forEach((practice, idx) => {
      const loc = practice.location ? ` (${practice.location.file})` : "";
      lines.push(`${idx + 1}. **${practice.title}**${loc}`);
      lines.push(`   ${practice.description}\n`);
    });
  }

  // === VULNERABILITIES ===
  if (response.vulnerabilities.length > 0) {
    lines.push("---\n## Vulnerabilities Found\n");

    // Group by severity
    const severityOrder: SecuritySeverity[] = ["critical", "high", "medium", "low"];

    for (const severity of severityOrder) {
      const vulns = response.vulnerabilities.filter(v => v.severity === severity);
      if (vulns.length === 0) continue;

      lines.push(`### ${severity.toUpperCase()} Severity\n`);

      for (const vuln of vulns) {
        lines.push(`#### ${vuln.id}. ${vuln.title}`);
        lines.push(`**Severity:** ${vuln.severity.toUpperCase()}`);

        if (vuln.location) {
          lines.push(`**Location:** \`${vuln.location.file}${vuln.location.line ? `:${vuln.location.line}` : ""}\``);
          if (vuln.location.snippet) {
            lines.push(`\`\`\`\n${vuln.location.snippet}\n\`\`\``);
          }
        }

        if (vuln.owasp) {
          lines.push(`**OWASP:** ${vuln.owasp}`);
        }

        lines.push(`\n**Issue:** ${vuln.issue}`);

        if (vuln.risk.length > 0) {
          lines.push("\n**Risk:**");
          vuln.risk.forEach(r => lines.push(`- ${r}`));
        }

        if (vuln.solution.length > 0) {
          lines.push("\n**Solution:**");
          vuln.solution.forEach(s => lines.push(`- ${s}`));
        }

        if (vuln.notes) {
          lines.push(`\n*Note: ${vuln.notes}*`);
        }

        lines.push("");
      }
    }
  }

  // === METRICS ===
  lines.push("---\n## Code Analysis Metrics\n");
  lines.push("| Metric | Value |");
  lines.push("|--------|-------|");
  lines.push(`| Total Files Analyzed | ${response.metrics.totalFilesAnalyzed} |`);
  lines.push(`| Security-Related Files | ${response.metrics.securityRelatedFiles} |`);
  lines.push(`| Error Boundaries | ${response.metrics.errorBoundaries} |`);
  lines.push(`| Secure Storage Operations | ${response.metrics.secureStorageOps} |`);
  lines.push(`| Positive Patterns Detected | ${response.metrics.totalPatternsDetected} |`);
  lines.push(`| Anti-patterns Found | ${response.metrics.antiPatternsFound} |`);

  // === RECOMMENDATIONS ===
  if (response.recommendations.length > 0) {
    lines.push("\n---\n## Recommended Next Steps\n");

    const priorityLabels: Record<string, string> = {
      immediate: "Immediate (Critical)",
      high: "High Priority",
      medium: "Medium Priority",
      ongoing: "Ongoing"
    };

    response.recommendations.forEach((rec, idx) => {
      lines.push(`${idx + 1}. **${priorityLabels[rec.priority]}:** ${rec.description}`);
    });
  }

  return lines.join("\n");
}

/**
 * Handler for security analysis tool
 */
export async function handleSecurityAnalysis(args: SecurityAnalysisArgs): Promise<any> {
  try {
    // Validate path
    if (!args.path) {
      return validationErrorResponse("Path is required for security analysis");
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

    // Perform analysis
    const response = await analyzeSecurityComprehensive(targetPath, {
      include: args.include,
      exclude: args.exclude,
      focus: args.focus,
      minSeverity: args.severity
    });

    // Format the report
    const formattedReport = formatSecurityReport(response);

    // Return both formatted report and structured data
    return {
      content: [{
        type: "text",
        text: formattedReport + "\n\n---\n\n```json\n" + JSON.stringify({
          summary: response.summary,
          metrics: response.metrics,
          vulnerabilitiesCount: response.vulnerabilities.length,
          positivePracticesCount: response.positivePractices.length
        }, null, 2) + "\n```"
      }]
    };

  } catch (err: unknown) {
    return errorResponse(err instanceof Error ? err.message : String(err));
  }
}
