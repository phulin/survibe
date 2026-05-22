export type GameStatus = "setup" | "camp" | "tribal" | "voting" | "reveal" | "complete";

export type PlayerKind = "human" | "ai" | "host";

export type PlayerStatus = "active" | "eliminated";

export type MessageChannel = "private" | "tribal" | "system";

export type AiMessageType =
  | "contestant_dossiers"
  | "current_task"
  | "game_event"
  | "no_response"
  | "private_message"
  | "response"
  | "tribal_answer"
  | "tribal_question"
  | "vote";

export type PlayerSummary = {
  id: string;
  kind: PlayerKind;
  name: string;
  status: PlayerStatus;
  placement: number | null;
  profile: AiProfile | null;
  publicFacts: string[];
  privateNotes: string[];
};

export type AiProfile = {
  archetype: string;
  biography: string;
  speechStyle: string;
  strategicStyle: string;
  riskTolerance: "low" | "medium" | "high";
  loyalty: number;
  deception: number;
  threatSensitivity: number;
  memorySummary: string;
};

export type GameMessage = {
  id: string;
  gameId: string;
  round: number;
  channel: MessageChannel;
  senderPlayerId: string | null;
  recipientPlayerId: string | null;
  content: string;
  createdAt: string;
};

export type VoteRecord = {
  id: string;
  round: number;
  voterId: string;
  targetId: string;
  rationale: string;
  confidence: number;
  createdAt: string;
};

export type GameEvent = {
  id: string;
  round: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

export type GameView = {
  id: string;
  status: GameStatus;
  round: number;
  humanPlayerId: string;
  createdAt: string;
  updatedAt: string;
  players: PlayerSummary[];
  messages: GameMessage[];
  votes: VoteRecord[];
  events: GameEvent[];
};

export type AiDebugContextMessage = {
  role: "system" | "user" | "assistant";
  content: string;
  sourceMessageId?: string;
};

export type AiDebugContext = {
  playerId: string;
  playerName: string;
  playerStatus: PlayerStatus;
  promptMessages: AiDebugContextMessage[];
  observedPrivateMessageCount: number;
};

export type AiDebugContextsResponse = {
  contexts: AiDebugContext[];
};

export type VoteDebugRecord = {
  voterName: string;
  targetName: string;
  rationale: string;
  confidence: number;
  createdAt: string;
};

export type VoteDebugResponse = {
  round: number;
  eliminatedPlayerName: string | null;
  votes: VoteDebugRecord[];
};

export type CreateGameRequest = {
  humanName: string;
  aiCount: number;
};

export type ChatRequest = {
  message: string;
};

export type TribalAnswerRequest = {
  message: string;
};

export type VoteRequest = {
  targetId: string;
};

export type ApiError = {
  error: string;
};
