#!/usr/bin/env node

/**
 * Token comparison script for original vs optimized vs ultra schemas
 * Uses approximate tokenization: ~4 chars per token
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(dirname(__filename)); // Go up to project root

function estimateTokens(text) {
  // Approximate: 1 token ≈ 4 characters (OpenAI/Anthropic average)
  return Math.ceil(text.length / 4);
}

function analyzeFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');

  // Extract tool definitions
  const toolsMatch = content.match(/export const tools.*?=.*?\[([\s\S]*)\];/);
  if (!toolsMatch) {
    throw new Error(`Could not extract tools from ${filePath}`);
  }

  const toolsContent = toolsMatch[1];
  const totalTokens = estimateTokens(toolsContent);

  // Count individual tools
  const toolMatches = toolsContent.split(/\{[\s]*name:/g).filter(t => t.trim());
  const toolCount = toolMatches.length;

  // Extract tool names
  const namePattern = /name:\s*"([^"]+)"/g;
  const names = [];
  let match;
  while ((match = namePattern.exec(toolsContent)) !== null) {
    names.push(match[1]);
  }

  // Calculate average tool name length
  const avgNameLength = names.reduce((sum, n) => sum + n.length, 0) / names.length;

  // Extract descriptions
  const descriptions = [];
  const descPattern = /description:\s*"([^"]+)"/g;
  while ((match = descPattern.exec(toolsContent)) !== null) {
    descriptions.push(match[1]);
  }

  return {
    totalTokens,
    toolCount,
    avgTokensPerTool: Math.ceil(totalTokens / toolCount),
    descriptions,
    descriptionTokens: descriptions.reduce((sum, d) => sum + estimateTokens(d), 0),
    names,
    avgNameLength: avgNameLength.toFixed(1)
  };
}

try {
  const original = analyzeFile(join(__dirname, 'src/tools/schemas.ts'));
  const optimized = analyzeFile(join(__dirname, 'src/tools/schemas.optimized.ts'));
  const ultra = analyzeFile(join(__dirname, 'src/tools/schemas.ultra.ts'));

  const savedOpt = original.totalTokens - optimized.totalTokens;
  const savedUltra = original.totalTokens - ultra.totalTokens;
  const percentOpt = ((savedOpt / original.totalTokens) * 100).toFixed(1);
  const percentUltra = ((savedUltra / original.totalTokens) * 100).toFixed(1);

  // MCP overhead calculation (641 tokens/tool reported vs actual)
  const mcpOverhead = 641 - original.avgTokensPerTool;
  const estimatedMcpOriginal = original.toolCount * 641;
  const estimatedMcpOpt = optimized.toolCount * (optimized.avgTokensPerTool + mcpOverhead);
  const estimatedMcpUltra = ultra.toolCount * (ultra.avgTokensPerTool + mcpOverhead);

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║           Token Usage Analysis (3-way comparison)            ║');
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║ Original Schema:                                             ║`);
  console.log(`║   Schema tokens:          ${String(original.totalTokens).padStart(6)} tokens                    ║`);
  console.log(`║   Avg per tool:           ${String(original.avgTokensPerTool).padStart(6)} tokens                    ║`);
  console.log(`║   Avg name length:        ${String(original.avgNameLength).padStart(6)} chars                    ║`);
  console.log(`║   Description tokens:     ${String(original.descriptionTokens).padStart(6)} tokens                    ║`);
  console.log(`║   Est. MCP total:         ${String(estimatedMcpOriginal).padStart(6)} tokens (@ 641/tool) ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║ Optimized Schema:                                            ║`);
  console.log(`║   Schema tokens:          ${String(optimized.totalTokens).padStart(6)} tokens                    ║`);
  console.log(`║   Avg per tool:           ${String(optimized.avgTokensPerTool).padStart(6)} tokens                    ║`);
  console.log(`║   Avg name length:        ${String(optimized.avgNameLength).padStart(6)} chars                    ║`);
  console.log(`║   Description tokens:     ${String(optimized.descriptionTokens).padStart(6)} tokens                    ║`);
  console.log(`║   Est. MCP total:         ${String(Math.ceil(estimatedMcpOpt)).padStart(6)} tokens                    ║`);
  console.log(`║   Saved vs original:      ${String(savedOpt).padStart(6)} tokens (${percentOpt}%)             ║`);
  console.log('╠══════════════════════════════════════════════════════════════╣');
  console.log(`║ Ultra-Optimized Schema:                                      ║`);
  console.log(`║   Schema tokens:          ${String(ultra.totalTokens).padStart(6)} tokens                    ║`);
  console.log(`║   Avg per tool:           ${String(ultra.avgTokensPerTool).padStart(6)} tokens                    ║`);
  console.log(`║   Avg name length:        ${String(ultra.avgNameLength).padStart(6)} chars                    ║`);
  console.log(`║   Description tokens:     ${String(ultra.descriptionTokens).padStart(6)} tokens                    ║`);
  console.log(`║   Est. MCP total:         ${String(Math.ceil(estimatedMcpUltra)).padStart(6)} tokens                    ║`);
  console.log(`║   Saved vs original:      ${String(savedUltra).padStart(6)} tokens (${percentUltra}%)             ║`);
  console.log(`║   Additional vs optimized: ${String(optimized.totalTokens - ultra.totalTokens).padStart(5)} tokens (${((optimized.totalTokens - ultra.totalTokens) / original.totalTokens * 100).toFixed(1)}%)             ║`);
  console.log('╚══════════════════════════════════════════════════════════════╝');

  console.log('\n📊 Estimated MCP Context Savings:');
  console.log(`   Original:      9,618 tokens`);
  console.log(`   Optimized:     ${Math.ceil(estimatedMcpOpt).toLocaleString()} tokens (saves ${(estimatedMcpOriginal - estimatedMcpOpt).toFixed(0)})`);
  console.log(`   Ultra:         ${Math.ceil(estimatedMcpUltra).toLocaleString()} tokens (saves ${(estimatedMcpOriginal - estimatedMcpUltra).toFixed(0)})`);

  console.log('\n🏆 Tool Name Comparison Examples:');
  console.log(`   Original          Optimized         Ultra`);
  console.log(`   ───────────────── ───────────────── ─────────────────`);
  for (let i = 0; i < Math.min(8, original.names.length); i++) {
    const orig = original.names[i].padEnd(17);
    const opt = optimized.names[i].padEnd(17);
    const ult = ultra.names[i];
    console.log(`   ${orig} ${opt} ${ult}`);
  }

} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
