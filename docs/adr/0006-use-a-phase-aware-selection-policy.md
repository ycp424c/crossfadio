# Use a Phase-Aware Selection Policy

Crossfadio will preserve the source of each constraint and Selection Pressure, then make separate Admission, Recall, Ranking, Batch, Final, and Trace decisions. It will not collapse every signal into one cross-phase penalty value, because hard constraints, autonomous recall suppression, soft ranking pressure, batch diversity, and final eligibility have different semantics and override rules.
