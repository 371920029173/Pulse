# SHE v2 — Architecture

**Structured Hierarchy Engine v2**: thin agent-runtime with Group Memory + PulseSeed retrieval.
Design truth: AGI-3.5-v2 + how-to-do docs. NOT AGI-3.5 max.
Landing path: `D:\AGI\AGI-use`

---

## System Overview

```
┌─────────────────────────────────────────────────────┐
│                   SHE v2 Agent                       │
│                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │  LLM Provider│  │  Tool Loop  │  │  Sandbox    │ │
│  │  (OpenAI-    │  │  read/edit/ │  │  (Job Object│ │
│  │   compatible)│  │  run/kb     │  │   + CWD jail│ │
│  └──────┬───────┘  └──────┬──────┘  └──────┬──────┘ │
│         │                 │                │        │
│  ┌──────┴─────────────────┴────────────────┴──────┐ │
│  │              Agent Runtime                      │ │
│  │   system prompt → chat → tool calls → loop     │ │
│  └──────────────────────┬──────────────────────────┘ │
│                         │                            │
│  ┌──────────────────────┴──────────────────────────┐ │
│  │           Group Knowledge Base                  │ │
│  │                                                 │ │
│  │   ┌─────────┐    PulseSeed    ┌──────────┐     │ │
│  │   │ Groups  │◄──Resonance───►│ Memories  │     │ │
│  │   │ (树+ref)│    Propagation  │ (nodes)   │     │ │
│  │   └────┬────┘                └─────┬─────┘     │ │
│  │        │                           │           │ │
│  │   ┌────┴────────────────────┬──────┘           │ │
│  │   │ Typed Edges             │                  │ │
│  │   │ co_occur│temporal│causal│weak│cross_group  │ │
│  │   └─────────────────────────┘                  │ │
│  │                                                 │ │
│  │   SQLite Store (structured, not vector)         │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

## 组结构 (Group Structure) → SHE v2 Adaptation

### What was adapted from AGI-3.5-v2

| AGI-3.5-v2 Concept | SHE v2 Implementation | Simplification |
|---|---|---|
| 组 (Group) | `Group` with id, parent, children, memories, edges | Same multi-way tree + cross-refs |
| 记忆节点 | `MemoryNode` with kind, content, metadata | Practical payloads (text/code/fact) instead of pulse waveforms |
| 弱边 (Weak edges) | `Edge` kind=weak | Pre-activation reachability only, never promoted to causal |
| 共现边 | `Edge` kind=co_occurrence | Observed together, no causal claim |
| 时序边 | `Edge` kind=temporal, direction=forward | Ordered, not causal |
| 因果候选边 | `Edge` kind=causal_candidate + evidence + falsifiers | Requires explicit evidence + at least one falsifier |
| 竞争子组 | `Group` with isCompetitionSubgroup=true | Contradictory candidates; context chooses, never force merge |
| 用进废退 | accessCount, lastAccessedAt, isDormant | Boost on access; long unused → dormant → compress |
| 激素标记 | hormoneMarker on Group | Priority/arousal signal |
| 信任常数 | trustConstant on Group | Reliability weighting |
| 脉冲种子 (PulseSeed) | `PulseSeed` struct with energy, hops, path | Structural resonance propagation, not embedding similarity |

### What was explicitly NOT ported

- Full oscillator / pulse-universe kernel
- G6/G7 metacognition layers (Phase-1-out-of-scope)
- Pulse waveform encoding of memories
- Continuous oscillation cycles
- Any reference to AGI-3.5 max

## PulseSeed Retrieval — How It Works

PulseSeed is the retrieval primitive. It replaces traditional RAG (cosine similarity over embeddings).

### Retrieval Flow

```
Query Text
    │
    ▼
┌──────────────────────┐
│ 1. Bootstrap Lookup  │  ← Lexical index finds entry points
│    (FTS5, structural)│     into the group structure. This is
└──────────┬───────────┘     NOT the retrieval mechanism.
           │
           ▼
┌──────────────────────┐
│ 2. Create PulseSeeds │  ← Each seed node spawns a PulseSeed
│    energy = 1.0      │     with initial energy bound to its
│    hop = 0           │     source group.
└──────────┬───────────┘
           │
           ▼
┌──────────────────────────────────────┐
│ 3. Structural Resonance Propagation  │
│                                      │
│  a. Group membership resonance:      │
│     siblings in same group activate  │
│                                      │
│  b. Edge traversal:                  │
│     weak → fast reachability         │
│     co_occurrence → shared context   │
│     temporal → sequence awareness    │
│     causal_candidate → strong link   │
│     cross_group → bridge groups      │
│                                      │
│  c. Hierarchical walk:              │
│     parent → sibling groups → down   │
│                                      │
│  d. Energy decay per hop:           │
│     energy *= (1 - decayRate)       │
│     stop when < resonanceThreshold  │
│                                      │
│  e. Dormancy gate:                  │
│     skip dormant unless energy > 2x  │
│     threshold                        │
└──────────┬───────────────────────────┘
           │
           ▼
┌──────────────────────┐
│ 4. Collect & Score   │  ← Nodes sorted by total received
│    activation traces │     energy. Each trace shows the
│    group paths       │     structural path that activated it.
└──────────────────────┘
```

### Why not RAG?

Traditional RAG uses embedding vectors + cosine similarity to find "semantically similar" chunks. This is opaque — you cannot explain *why* a result was returned beyond "the vectors were close."

PulseSeed retrieval is **structural and explainable**:
- Every result comes with an activation trace showing exactly which groups, edges, and hops led to it
- The group hierarchy provides organizational context (like folders, but with cross-references)
- Edge types preserve the *nature* of relationships (co-occurrence ≠ causation)
- Competition subgroups maintain contradictory possibilities instead of averaging them away
- Dormancy implements 用进废退 (use-advance / waste-retreat) — knowledge that isn't used fades

### Edge Type Discipline (non-negotiable rules)

1. **Weak edges** are pre-activation hints. They say "these might be related, check them early." They do NOT prove semantic similarity.

2. **Co-occurrence edges** record that two things appeared together. Co-occurrence ≠ causation. Never promote.

3. **Temporal edges** record order (A happened before B). Order ≠ causation. Never promote.

4. **Causal-candidate edges** are directional and MUST carry:
   - `evidence`: why this causal link is hypothesized
   - `falsifiers[]`: conditions that would disprove it
   Without both, the edge cannot be created.

5. **No automatic promotion**: the system never upgrades co_occurrence → causal or temporal → causal. A human or explicit agent action with evidence is required.

## Package Structure

```
packages/
  shared/          ← Types (PulseSeed, Group, Edge, etc.), config, logger
  kb/              ← Group KB engine: store (SQLite) + engine (PulseSeed retrieval)
  sandbox/         ← Sandboxed shell (Job Object on Windows, process group on Linux)
  agent-runtime/   ← LLM providers, tool loop, system prompt
  she-cli/         ← CLI: she chat / she kb ingest / she kb query / she doctor
  server/          ← REST API server (Node http, no framework)
  ui/              ← React web UI: chat + sidebar + PulseSeed visualization
```

## Sandbox Security Model

- CWD jail: all file operations confined to workspace root
- Destructive command deny-list: `rm -rf`, `git push --force`, `format`, etc.
- Default policy: **deny** destructive calls without confirmation (denyDestructiveByDefault)
- Windows: designed for Job Object process isolation
- Timeout + output size limits on all commands

## Configuration

Layered: defaults → config.yaml → environment variables

```
.env                  ← API keys (never committed)
config.yaml           ← Project-level settings
SHE_* env vars        ← Override any setting
```
