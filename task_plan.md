# Task Plan: Survivor AI Benchmark MVP

## Goal
Create the initial design documentation for a Vite, TypeScript, React MVP where a human competes against AI players in post-merge Survivor-style social strategy rounds, then initialize version control and commit the artifact.

## Phases
- [x] Phase 1: Inspect repo and constraints
- [x] Phase 2: Capture relevant API/design notes
- [x] Phase 3: Write design document
- [x] Phase 4: Initialize git and commit

## Key Questions
1. What is the smallest playable post-merge loop for an MVP?
2. How should AI identities, private chats, Tribal Council, votes, and persistence fit together?
3. Where should the OpenAI API be called so the browser never receives the API key?

## Decisions Made
- Use a backend API boundary for all OpenAI calls: keeps the API key server-side and avoids reading `.env` into assistant context.
- Start at post-merge only: avoids tribe-swap, challenge, and pre-merge complexity while preserving the social politics core.
- Keep AI players persistent via explicit character profiles and memory summaries: maintains continuity without requiring full transcript replay every turn.

## Errors Encountered
- `git status --short` failed because the directory was not yet a git repository; this is expected and will be resolved in Phase 4.

## Status
**Complete** - Design document written, repository initialized, and initial commit created.
