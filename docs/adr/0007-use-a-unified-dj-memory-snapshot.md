# Use a Unified DJ Memory Snapshot

Crossfadio will assemble one bounded DJ Memory Snapshot for each DJ operation, then derive purpose-specific chat, selection, and segue projections from it. The snapshot is a point-in-time read model with source and freshness metadata; it does not replace the authoritative queue, listening, preference, directive, exclusion, Personal DJ Context, or DJ Session Log stores. Chat, selection, and segue have no parallel runtime context or legacy selection path; rollback is performed by switching to the preserved pre-v2 branch while additive schema remains readable.

Listening Episode 明细最多保留最近 200 条；Selection Pressure 另存按 track 与 primary artist 聚合的完整 60 天投影，因此 Snapshot 保持有界，同时不会因高活跃用户的明细截断丢失 Early Skip 或 Exposure 事实。
