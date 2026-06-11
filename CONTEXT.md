# Crossfadio Music Selection

This context names the domain concepts used when Crossfadio recalls, ranks, and selects music candidates for playback.

## Language

**Candidate Quality Signal**:
Evidence about whether a recalled song candidate is likely to be usable and worth selecting, based on platform metadata such as popularity, availability, and metadata completeness.
_Avoid_: quality score, low quality song

**Quality Signals**:
The collection of candidate quality signals attached to a recalled song candidate.
_Avoid_: scores, ranking score

**Title Pollution Signal**:
Evidence that a recalled song candidate's title appears to be assembled from search terms, scene words, or collection-style descriptors rather than naming a specific song.
_Avoid_: title duplicate penalty, same-song dedupe
