# Actual Token Usage Comparison

## Original vs Ultra-Optimized

| Tool | Original | Ultra | Saved | % Reduction |
|------|----------|-------|-------|-------------|
| startSession → start | 908 | 838 | 70 | 7.7% |
| submitCandidate → submit | 953 | 795 | 158 | 16.6% |
| getFileContent → read | 644 | 587 | 57 | 8.9% |
| getState → state | 578 | 564 | 14 | 2.4% |
| shouldHalt → halt | 573 | 564 | 9 | 1.6% |
| endSession → end | 571 | 563 | 8 | 1.4% |
| validateCandidate → validate | 766 | 745 | 21 | 2.7% |
| getSuggestions → suggest | 590 | 564 | 26 | 4.4% |
| saveCheckpoint → save | 595 | 573 | 22 | 3.7% |
| restoreCheckpoint → restore | 594 | 579 | 15 | 2.5% |
| listCheckpoints → list | 573 | 564 | 9 | 1.6% |
| resetToBaseline → reset | 582 | 564 | 18 | 3.1% |
| undoLastCandidate → undo | 595 | 567 | 28 | 4.7% |
| getFileLines → lines | 677 | 603 | 74 | 10.9% |
| suggestFix → fix | 619 | 564 | 55 | 8.9% |
| **TOTAL (15 tools)** | **9,618** | **9,234** | **384** | **4.0%** |

## Analysis

**Actual savings: 384 tokens (4.0%)**

This is lower than expected because:

1. **MCP protocol overhead dominates**: The ~7,200 token overhead (metadata, serialization) is mostly unaffected by our optimizations
2. **Small schema portion**: Our optimizations only affect ~2,400 tokens of the total 9,618
3. **Limited impact of name shortening**: Tool name changes save tokens in the schema definition but the MCP protocol adds back overhead per tool

## Per-Tool Savings Breakdown

**Best savings:**
- `submitCandidate → submit`: -158 tokens (16.6%) - largest, most complex schema
- `getFileLines → lines`: -74 tokens (10.9%) - many parameters
- `startSession → start`: -70 tokens (7.7%) - complex nested schema

**Minimal savings:**
- Simple tools (`state`, `halt`, `end`): -8 to -14 tokens (1-2%)
- Already minimal schemas with few parameters

## Recommendations

### 1. Current 4% savings is still valuable
- Frees up 384 tokens for context
- Equivalent to ~100 lines of code
- Zero functionality loss

### 2. Focus optimization efforts elsewhere
For more significant token savings, consider:
- **Incremental file reading** (getFileLines): 30-50% savings on large files
- **Targeted context**: Only load files relevant to current task
- **Compact feedback**: The tool already optimizes error messages

### 3. MCP Protocol is the bottleneck
The 303% overhead from MCP protocol (7,200 tokens) is the real issue. This is outside our control and requires MCP SDK improvements.

## Conclusion

The **ultra-optimized schemas provide 4% real-world savings (384 tokens)**, which is useful but not game-changing. The major bottleneck is MCP protocol overhead, not schema verbosity.

**Best practices for token efficiency:**
1. Use `getFileLines` for large files instead of full `getFileContent`
2. Only read files you'll actually modify
3. Keep candidate changes small and focused
4. Use ultra-optimized schemas (active now) for every bit of savings
