---
name: post-commit-autolearn
description: Auto-learning post-commit notification
trigger: post-commit
enabled: true
---

# LLM-MEMORY-AUTO-LEARNING
# Post-Commit Hook - Auto-Learning Integration

After a commit is made, this hook:

1. Notifies you if the commit was tagged with #kb for auto-learning
2. Reminds you to process the queue when convenient
3. Shows the current queue size

The actual commit capture is handled by the git post-commit hook.
This Claude Code hook just provides visibility and reminders.

Use the dev-memory-manager agent to process queued commits.
