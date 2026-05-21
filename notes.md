# Notes: Survivor AI Benchmark MVP

## Sources

### Official OpenAI API docs
- URL: https://platform.openai.com/docs/guides/streaming-responses
- Key points:
  - The Responses API supports streaming via semantic server-sent events.
  - Streaming is useful for conversational UX where users should see output as it is generated.

### Official OpenAI Structured Outputs docs
- URL: https://platform.openai.com/docs/guides/structured-outputs?api-mode=responses&lang=javascript
- Key points:
  - Structured Outputs can constrain model responses to a JSON schema.
  - The JavaScript SDK supports Zod-backed structured output helpers.

## Synthesized Findings

### Product Scope
- The MVP should model only post-merge rounds: camp phase private chats, immunity result, Tribal Council questioning, voting, elimination, and repeat until final outcome.
- The core benchmark metric is how long a human survives and how many AI opponents they can outplay.

### Architecture
- Vite, TypeScript, and React should own the browser client.
- A server-side API layer should own OpenAI calls, prompt assembly, memory writes, and game-state mutation.
- The OpenAI API key should be loaded only by the server process from environment variables.

### AI Behavior
- Each AI player needs a stable identity profile, strategy, relationship state, and compact private memory.
- Routine chat can use streaming text.
- Votes, confessionals, Tribal Council answers, and strategic decisions should use structured output schemas where possible.
