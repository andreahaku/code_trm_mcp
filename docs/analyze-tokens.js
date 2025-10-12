#!/usr/bin/env node

/**
 * Token comparison script for original vs optimized schemas
 * Uses approximate tokenization: ~4 chars per token
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function estimateTokens(text) {
  // Approximate: 1 token ≈ 4 characters (OpenAI/Anthropic average)
  return Math.ceil(text.length / 4);
}

function analyzeFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');

  // Extract tool definitions (between export const tools and the closing bracket)
  const toolsMatch = content.match(/export const tools.*?=.*?\[([\s\S]*)\];/);
  if (!toolsMatch) {
    throw new Error(`Could not extract tools from ${filePath}`);
  }

  const toolsContent = toolsMatch[1];
  const totalTokens = estimateTokens(toolsContent);

  // Count individual tools
  const toolMatches = toolsContent.split(/\{[\s]*name:/g).filter(t => t.trim());
  const toolCount = toolMatches.length;

  // Extract descriptions for analysis
  const descriptions = [];
  const descPattern = /description:\s*"([^"]+)"/g;
  let match;
  while ((match = descPattern.exec(toolsContent)) !== null) {
    descriptions.push(match[1]);
  }

  return {
    totalTokens,
    toolCount,
    avgTokensPerTool: Math.ceil(totalTokens / toolCount),
    descriptions,
    descriptionTokens: descriptions.reduce((sum, d) => sum + estimateTokens(d), 0)
  };
}

try {
  const original = analyzeFile(join(__dirname, 'src/tools/schemas.ts'));
  const optimized = analyzeFile(join(__dirname, 'src/tools/schemas.optimized.ts'));

  const tokensSaved = original.totalTokens - optimized.totalTokens;
  const percentSaved = ((tokensSaved / original.totalTokens) * 100).toFixed(1);

  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║           Token Usage Analysis                           ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║ Original Schema:                                         ║`);
  console.log(`║   Total tokens:           ${String(original.totalTokens).padStart(6)} tokens              ║`);
  console.log(`║   Tools:                  ${String(original.toolCount).padStart(6)}                    ║`);
  console.log(`║   Avg per tool:           ${String(original.avgTokensPerTool).padStart(6)} tokens              ║`);
  console.log(`║   Description tokens:     ${String(original.descriptionTokens).padStart(6)} tokens              ║`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║ Optimized Schema:                                        ║`);
  console.log(`║   Total tokens:           ${String(optimized.totalTokens).padStart(6)} tokens              ║`);
  console.log(`║   Tools:                  ${String(optimized.toolCount).padStart(6)}                    ║`);
  console.log(`║   Avg per tool:           ${String(optimized.avgTokensPerTool).padStart(6)} tokens              ║`);
  console.log(`║   Description tokens:     ${String(optimized.descriptionTokens).padStart(6)} tokens              ║`);
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║ Savings:                                                 ║`);
  console.log(`║   Tokens saved:           ${String(tokensSaved).padStart(6)} tokens (${percentSaved}%)      ║`);
  console.log(`║   Avg savings per tool:   ${String(Math.ceil(tokensSaved / original.toolCount)).padStart(6)} tokens              ║`);
  console.log('╚══════════════════════════════════════════════════════════╝');

  console.log('\n📊 Top 5 Description Reductions:');
  for (let i = 0; i < Math.min(5, original.descriptions.length); i++) {
    const origTokens = estimateTokens(original.descriptions[i]);
    const optTokens = estimateTokens(optimized.descriptions[i]);
    const saved = origTokens - optTokens;

    console.log(`\n${i + 1}. Original (${origTokens} tokens):`);
    console.log(`   "${original.descriptions[i]}"`);
    console.log(`   Optimized (${optTokens} tokens, -${saved}):`);
    console.log(`   "${optimized.descriptions[i]}"`);
  }

} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
