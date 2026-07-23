# Use a Phase-Aware Selection Policy

Crossfadio will preserve the source of each constraint and Selection Pressure, then make separate Admission, Recall, Ranking, Batch, Final, and Trace decisions. It will not collapse every signal into one cross-phase penalty value, because hard constraints, autonomous recall suppression, soft ranking pressure, batch diversity, and final eligibility have different semantics and override rules.

Durable selection rotation is an explicit exception to phase-local historical pressure. Its logical-round hard window suppresses autonomous candidates during Recall, excludes them from ranking and convergence counts, and is rechecked during Final against the latest committed ledger. Its outer window remains soft Ranking pressure. A current explicit track request may bypass both windows under ADR-0005; queue idempotency, playback eligibility, and explicit exclusions remain hard.
