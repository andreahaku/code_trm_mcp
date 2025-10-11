---
name: pre-response-autolearn
description: Auto-learning knowledge retrieval
trigger: pre-response
enabled: true
---

# LLM-MEMORY-AUTO-LEARNING
# Pre-Response Hook - Auto-Learning Integration

Before Claude responds, this hook:

1. Checks if there are relevant auto-learned memories for the current context
2. Surfaces recently captured patterns and insights
3. Suggests using the dev-memory-manager agent if relevant knowledge exists

This helps ensure Claude has access to your team's captured development knowledge
before providing guidance or solutions.

Use the dev-memory-manager agent to:
- Search for relevant auto-learned patterns
- Update existing knowledge
- Capture new insights
