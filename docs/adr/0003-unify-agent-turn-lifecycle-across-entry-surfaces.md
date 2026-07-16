---
status: accepted
---

# Unify Agent Turn lifecycle across entry surfaces

Every entry surface uses one authoritative Agent Turn lifecycle for Source Conversation deletion barriers, per-thread ordering, canonical trajectory, successful result commit, artifacts, and Skill Candidate scheduling. An accepted external-channel submission remains durable when the turn fails because it may not be replayable, while agent-produced results require successful completion; external delivery is a separate outcome and never rolls back or reruns a completed turn.
