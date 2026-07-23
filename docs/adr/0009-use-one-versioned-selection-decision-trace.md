# Use One Versioned Selection Decision Trace

Crossfadio will represent Admission, Recall, Ranking, Batch, and Final selection decisions in one versioned shared schema with stable reason codes, actions, provenance, and bounded evidence references. Prompt, structured-log, SSE, and UI payloads will be purpose-specific projections of this trace rather than independently maintained contracts; projections must remain valid structured data and may not contain chain-of-thought, raw prompts, chat transcripts, or private Personal DJ Context. Numeric scores remain diagnostic details and are not the semantic contract.

Adding the durable `selection_rotation` provenance source advances the trace schema to v2. Readers accept and normalize persisted v1 traces, while all new producers emit v2. Strict replay exports similarly advance their schema when new rotation evidence fields are added; the current replayer keeps an explicit legacy-version reader rather than silently changing an existing version.
