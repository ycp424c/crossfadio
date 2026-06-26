# Use a Local SQLite Semantic Index First

MusicAgent semantic discovery will first store music entities and embeddings in the existing SQLite database and perform local brute-force cosine search. This avoids introducing DashVector, pgvector, or another managed vector store before the user-local corpus size and retrieval latency justify it, while preserving a clear migration path if semantic lookup becomes a measured bottleneck.
