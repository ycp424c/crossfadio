# Use DJ Session Log for Continuity, Not Event Sourcing

Crossfadio will add a per-user DJ Session Log to preserve DJ continuity across listener requests, personal DJ context, selection decisions, queue changes, and segues. The first version will not make this log the event-sourcing source of truth for playback state; existing message, play, segue, queue, and preference stores remain responsible for their current behavior. This keeps the DJ experience coherent without forcing queue replay, playback recovery, and full event migration into the first implementation.
