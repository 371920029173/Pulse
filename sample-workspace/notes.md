# Project Notes

## Architecture Decisions

### Database Choice
We chose SQLite for the Group KB because:
- Zero configuration, single-file database
- Excellent read performance for local agent use
- Supports FTS5 for bootstrap text search
- Portable across Windows/Linux/macOS

### PulseSeed vs Embeddings
Traditional RAG uses vector embeddings (e.g., text-embedding-ada-002) to find similar chunks.
We use PulseSeed structural resonance because:
1. Results are explainable — every match has an activation trace
2. Group structure preserves organizational context
3. Edge types maintain relationship semantics
4. Competition subgroups handle contradictions properly
5. 用进废退 (use-advance / waste-retreat) naturally prioritizes active knowledge

### Sandbox Design
The sandbox uses Windows Job Objects for process isolation:
- All child processes are contained in a job
- Resource limits (memory, CPU time) can be set per job
- Process tree termination on timeout
- On Linux: process groups + cgroups as fallback

## TODO for Future Phases
- [ ] Browser tool for web research
- [ ] Image understanding via multimodal API
- [ ] Multi-agent collaboration
- [ ] G6/G7 metacognition layers (Phase 2)
