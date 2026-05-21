import { Bug, Clock, Crown, MessageCircle, Play, Send, Skull, Users, Vote } from "lucide-react";
import { FormEvent, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  advanceToTribal,
  answerTribalCouncil,
  castVote,
  createGame,
  getDebugAiContexts,
  getGame,
  revealVotes,
  sendChat,
} from "./engine/client";
import type { AiDebugContext, AiDebugContextMessage, GameMessage, GameView, PlayerSummary } from "@survibe/shared";

const nearBottomScrollThreshold = 80;

const tribalPanelStatuses = new Set<GameView["status"]>(["tribal", "voting", "reveal"]);

const playerName = (game: GameView | null, playerId: string | null) => {
  if (!game || !playerId) {
    return "System";
  }

  return game.players.find((player) => player.id === playerId)?.name ?? `Contestant ${playerId.slice(0, 8)}`;
};

const activeContestants = (game: GameView) => game.players.filter((contestant) => contestant.kind !== "host" && contestant.status === "active");

const aiContestants = (game: GameView) => game.players.filter((contestant) => contestant.kind === "ai" && contestant.status === "active");

const isTribalPanelStatus = (status: GameView["status"]) => tribalPanelStatuses.has(status);

const privateMessagesFor = (messages: GameMessage[], humanId: string, aiId: string) =>
  messages.filter(
    (message) =>
      message.channel === "private" &&
      ((message.senderPlayerId === humanId && message.recipientPlayerId === aiId) ||
        (message.senderPlayerId === aiId && message.recipientPlayerId === humanId)),
  );

const chatBubbleContent = (content: string) => content.replace(/^Message (?:to|from) [^:]+:\s*/i, "");

const LoadingDots = ({ label }: { label: string }) => (
  <span className="typing-dots" aria-label={label}>
    <span />
    <span />
    <span />
  </span>
);

type PendingChat = {
  aiId: string;
  message: string;
};

type PendingChats = Record<string, PendingChat>;

type PendingTribalAnswer = {
  round: number;
  message: string;
};

type VoteTallyRow = {
  playerId: string;
  playerName: string;
  votes: number;
};

type RecentGame = {
  id: string;
  name: string;
  status: GameView["status"];
  round: number;
  updatedAt: string;
  activeContestants: number;
};

const recentGamesStorageKey = "survibe.recentGames.v1";
const recentGameLimit = 8;

const gameAdjectives = [
  "Clever",
  "Hidden",
  "Lucky",
  "Bold",
  "Quiet",
  "Golden",
  "Steady",
  "Wily",
  "Swift",
  "Sharp",
  "Brave",
  "Secret",
  "Bright",
  "Patient",
  "Restless",
  "Loyal",
];

const gameNouns = [
  "Torch",
  "Cove",
  "Palm",
  "Compass",
  "Lagoon",
  "Tide",
  "Shelter",
  "Flint",
  "Beacon",
  "Summit",
  "Council",
  "Drift",
  "Reef",
  "Signal",
  "Harbor",
  "Trail",
];

const hashText = (value: string) =>
  [...value].reduce((hash, char) => {
    return (hash * 31 + char.charCodeAt(0)) >>> 0;
  }, 17);

const generatedGameName = (gameId: string, existingNames: Set<string>) => {
  const baseHash = hashText(gameId);

  for (let offset = 0; offset < gameAdjectives.length * gameNouns.length; offset += 1) {
    const adjective = gameAdjectives[(baseHash + offset) % gameAdjectives.length];
    const noun = gameNouns[(Math.floor(baseHash / gameAdjectives.length) + offset) % gameNouns.length];
    const name = `${adjective} ${noun}`;

    if (!existingNames.has(name)) {
      return name;
    }
  }

  return `Cast ${baseHash.toString(36).slice(0, 4).toUpperCase()}`;
};

const parseRecentGames = (value: string | null): RecentGame[] => {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((item) => {
      if (!item || typeof item !== "object") {
        return [];
      }

      const record = item as Record<string, unknown>;
      if (
        typeof record.id !== "string" ||
        typeof record.name !== "string" ||
        typeof record.status !== "string" ||
        typeof record.round !== "number" ||
        typeof record.updatedAt !== "string" ||
        typeof record.activeContestants !== "number" &&
        typeof record.activePlayers !== "number"
      ) {
        return [];
      }

      const activeContestantCount =
        typeof record.activeContestants === "number" ? record.activeContestants : Number(record.activePlayers);

      return [
        {
          id: record.id,
          name: record.name,
          status: record.status as RecentGame["status"],
          round: record.round,
          updatedAt: record.updatedAt,
          activeContestants: activeContestantCount,
        },
      ];
    });
  } catch {
    return [];
  }
};

const loadRecentGames = () => {
  try {
    return parseRecentGames(window.localStorage.getItem(recentGamesStorageKey));
  } catch {
    return [];
  }
};

const saveRecentGames = (games: RecentGame[]) => {
  try {
    window.localStorage.setItem(recentGamesStorageKey, JSON.stringify(games));
  } catch {
    // Recent games are only a convenience; gameplay should continue if storage is unavailable.
  }
};

const rememberGame = (game: GameView) => {
  const current = loadRecentGames();
  const existing = current.find((item) => item.id === game.id);
  const existingNames = new Set(current.filter((item) => item.id !== game.id).map((item) => item.name));
  const recentGame: RecentGame = {
    id: game.id,
    name: existing?.name ?? generatedGameName(game.id, existingNames),
    status: game.status,
    round: game.round,
    updatedAt: game.updatedAt,
    activeContestants: activeContestants(game).length,
  };
  const next = [recentGame, ...current.filter((item) => item.id !== game.id)]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, recentGameLimit);

  saveRecentGames(next);
  return next;
};

const formatRecentDate = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "Recently";
  }

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
};

const gameIdFromPath = () => {
  const match = /^\/games\/([^/]+)$/.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
};

const setGamePath = (gameId: string | null) => {
  const nextPath = gameId ? `/games/${encodeURIComponent(gameId)}` : "/";

  if (window.location.pathname !== nextPath) {
    window.history.pushState({}, "", nextPath);
  }
};

const parseVoteTally = (value: unknown): VoteTallyRow[] => {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((row) => {
    if (!row || typeof row !== "object") {
      return [];
    }

    const record = row as Record<string, unknown>;
    const playerId = typeof record.playerId === "string" ? record.playerId : "";
    const playerNameValue = record.playerName;
    const votesValue = record.votes;

    if (typeof playerNameValue !== "string" || typeof votesValue !== "number") {
      return [];
    }

    return [{ playerId, playerName: playerNameValue, votes: votesValue }];
  });
};

const voteTallyForRound = (game: GameView, round: number) => {
  const eliminated = game.events.filter((event) => event.type === "player_eliminated" && event.round === round).at(-1);

  if (!eliminated) {
    return null;
  }

  const savedRows = parseVoteTally(eliminated.payload.voteTally);
  if (savedRows.length > 0) {
    return {
      round: eliminated.round,
      rows: savedRows,
    };
  }

  return null;
};

const votesCastForCurrentRound = (game: GameView) => {
  const event = game.events.filter((item) => item.type === "votes_cast" && item.round === game.round).at(-1);
  if (!event) {
    return null;
  }

  return typeof event.payload.totalVotes === "number" ? event.payload.totalVotes : activeContestants(game).length;
};

const Setup = ({
  onCreate,
  onResume,
  busy,
  recentGames,
}: {
  onCreate: (name: string, aiCount: number) => void;
  onResume: (gameId: string) => void;
  busy: boolean;
  recentGames: RecentGame[];
}) => {
  const [name, setName] = useState("Alex Vale");
  const [aiCount, setAiCount] = useState(6);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onCreate(name, aiCount);
  };

  return (
    <main className="setup">
      <section className="setup-panel">
        <div>
          <p className="eyebrow">Post-merge benchmark</p>
          <h1>Survibe</h1>
          <p className="lede">One human enters a live social vote against named AI contestants.</p>
        </div>
        <div className="setup-stack">
          <form className="setup-form" onSubmit={submit}>
            <label>
              Display name
              <input id="display-name" name="display-name" value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              AI opponents
              <input
                id="ai-count"
                name="ai-count"
                type="number"
                min={2}
                max={8}
                value={aiCount}
                onChange={(event) => setAiCount(Number(event.target.value))}
              />
            </label>
            <button className="primary" type="submit" disabled={busy}>
              <Users size={18} />
              Start game
            </button>
          </form>
          {recentGames.length > 0 ? (
            <section className="recent-games" aria-labelledby="recent-games-title">
              <div className="recent-header">
                <div>
                  <p className="eyebrow">Continue</p>
                  <h2 id="recent-games-title">Recent games</h2>
                </div>
                <Clock size={20} />
              </div>
              <div className="recent-list">
                {recentGames.map((recentGame) => (
                  <button className="recent-game" key={recentGame.id} type="button" onClick={() => onResume(recentGame.id)} disabled={busy}>
                    <span>
                      <strong>{recentGame.name}</strong>
                      <small>
                        Round {recentGame.round} / {recentGame.status} / {recentGame.activeContestants} active
                      </small>
                    </span>
                    <span className="recent-meta">
                      <small>{formatRecentDate(recentGame.updatedAt)}</small>
                      <Play size={16} />
                    </span>
                  </button>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </section>
    </main>
  );
};

const Roster = ({ game, selectedId, onSelect }: { game: GameView; selectedId: string | null; onSelect: (id: string) => void }) => (
  <aside className="rail roster">
    <div className="rail-title">
      <Users size={18} />
      <span>Cast</span>
    </div>
    {isTribalPanelStatus(game.status) ? (
      <button className="tribal-shortcut selected" type="button" aria-pressed="true">
        <span className="avatar">
          <Crown size={17} />
        </span>
        <span>
          <strong>Tribal Council</strong>
          <small>Public answers and vote</small>
        </span>
        <Vote size={16} />
      </button>
    ) : null}
    <div className="contestants">
      {game.players
        .filter((player) => player.kind !== "host")
        .map((player) => (
          <button
            className={`contestant ${selectedId === player.id ? "selected" : ""} ${player.status}`}
            key={player.id}
            onClick={() => player.kind === "ai" && player.status === "active" && onSelect(player.id)}
            disabled={player.kind !== "ai" || player.status !== "active"}
            type="button"
          >
            <span className="avatar">{player.kind === "human" ? "H" : player.name.slice(0, 1)}</span>
            <span>
              <strong>{player.name}</strong>
              <small>{player.profile?.archetype ?? "Contestant"}</small>
            </span>
            {player.profile ? (
              <span className="contestant-card" role="tooltip">
                <strong>{player.profile.archetype}</strong>
                <span>{player.profile.biography}</span>
                <span>Speech: {player.profile.speechStyle}</span>
                <span>Strategy: {player.profile.strategicStyle}</span>
              </span>
            ) : null}
            {player.status === "eliminated" ? <Skull size={16} /> : null}
          </button>
        ))}
    </div>
  </aside>
);

const parseDebugContent = (content: string) => {
  try {
    return JSON.parse(content) as unknown;
  } catch {
    return content;
  }
};

const asDebugText = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : null);

const formatDebugKey = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());

const debugTypeName = (type: string | null) => {
  switch (type) {
    case "contestant_dossiers":
      return "Dossiers";
    case "current_task":
      return "Task";
    case "game_event":
      return "Event";
    case "no_response":
      return "No Response";
    case "private_message":
      return "PM";
    case "response":
      return "Response";
    case "tribal_answer":
      return "Tribal";
    case "tribal_question":
      return "Question";
    case "vote":
      return "Vote";
    default:
      return "Message";
  }
};

const debugSpeakerName = (role: AiDebugContextMessage["role"]) => {
  if (role === "assistant") {
    return "Agent";
  }

  if (role === "user") {
    return "User";
  }

  return "System";
};

const debugMessageLabel = (message: AiDebugContextMessage) => {
  if (message.role === "system") {
    return "System Prompt";
  }

  try {
    const parsed = JSON.parse(message.content) as Record<string, unknown>;
    const rawType = asDebugText(parsed.type);

    if (rawType === "game_event") {
      const eventType = asDebugText(parsed.eventType);
      return eventType ? formatDebugKey(eventType) : "Game Event";
    }

    const type = debugTypeName(rawType);

    return `${debugSpeakerName(message.role)} ${type}`;
  } catch {
    return `${debugSpeakerName(message.role)} Message`;
  }
};

const debugMessageDetail = (message: AiDebugContextMessage) => {
  if (message.role === "system") {
    return "Identity, game rules, protocol, and private memory.";
  }

  try {
    const parsed = JSON.parse(message.content) as Record<string, unknown>;
    const rawType = asDebugText(parsed.type);
    const sender = asDebugText(parsed.senderName);
    const recipient = asDebugText(parsed.recipientName);
    const summary = asDebugText(parsed.summary);

    if (rawType === "game_event") {
      const payload = parsed.payload && typeof parsed.payload === "object" ? (parsed.payload as Record<string, unknown>) : {};

      if (parsed.eventType === "player_eliminated") {
        return asDebugText(payload.playerName);
      }

      if (parsed.eventType === "round_started") {
        const round = typeof parsed.round === "number" ? parsed.round : null;
        return round ? `Round ${round}` : null;
      }

      if (parsed.eventType === "tribal_answers_completed") {
        return null;
      }

      return summary;
    }

    if (sender && recipient) {
      return `${sender} -> ${recipient}`;
    }

    if (sender) {
      return sender;
    }

    return null;
  } catch {
    return null;
  }
};

const hiddenDebugBodyKeys = new Set(["type", "round", "senderName", "recipientName"]);

const DebugJsonValue = ({ value, depth = 0 }: { value: unknown; depth?: number }) => {
  if (value === null) {
    return <span className="debug-json-null">null</span>;
  }

  if (typeof value === "string") {
    return <span className="debug-json-string">{value}</span>;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return <span className="debug-json-primitive">{String(value)}</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return <span className="debug-json-muted">None</span>;
    }

    return (
      <div className="debug-json-list">
        {value.map((item, index) => (
          <div className="debug-json-list-item" key={index}>
            <span className="debug-json-index">{index + 1}</span>
            <DebugJsonValue value={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([key]) => !hiddenDebugBodyKeys.has(key));
    if (entries.length === 0) {
      return <span className="debug-json-muted">Empty</span>;
    }

    return (
      <div className={`debug-json-object ${depth > 0 ? "nested" : ""}`}>
        {entries.map(([key, item]) => (
          <div className="debug-json-row" key={key}>
            <span className="debug-json-key">{formatDebugKey(key)}</span>
            <div className="debug-json-value">
              <DebugJsonValue value={item} depth={depth + 1} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return <span className="debug-json-muted">{String(value)}</span>;
};

const DebugMessageBody = ({ content }: { content: string }) => {
  const parsed = parseDebugContent(content);

  if (typeof parsed === "string") {
    return <div className="debug-text-body">{parsed}</div>;
  }

  return <DebugJsonValue value={parsed} />;
};

const DebugContextPanel = ({ context }: { context: AiDebugContext | null }) => (
  <aside className="debug-panel" aria-label="AI context debug panel">
    <header className="debug-header">
      <div>
        <p className="eyebrow">Debug</p>
        <h3>AI context</h3>
      </div>
      <Bug size={19} />
    </header>
    {context ? (
      <>
        <div className="debug-meta">
          <span>{context.promptMessages.length} prompt messages</span>
          <span>{context.observedPrivateMessageCount} private observed</span>
        </div>
        <div className="debug-messages">
          {context.promptMessages.map((message, index) => {
            const detail = debugMessageDetail(message);

            return (
              <details className={`debug-message ${message.role}`} key={`${message.sourceMessageId ?? message.role}-${index}`}>
                <summary>
                  <span className="debug-type">{debugMessageLabel(message)}</span>
                  {detail ? <span>{detail}</span> : null}
                </summary>
                <div className="debug-message-body">
                  <DebugMessageBody content={message.content} />
                </div>
              </details>
            );
          })}
        </div>
      </>
    ) : (
      <div className="empty-state">Debug context is unavailable for this conversation.</div>
    )}
  </aside>
);

const ChatPanel = ({
  game,
  selectedAi,
  debugContext,
  busy,
  pendingChats,
  onSend,
}: {
  game: GameView;
  selectedAi: PlayerSummary | null;
  debugContext: AiDebugContext | null;
  busy: boolean;
  pendingChats: PendingChats;
  onSend: (message: string) => void;
}) => {
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const refocusAfterSend = useRef(false);
  const messages = selectedAi ? privateMessagesFor(game.messages, game.humanPlayerId, selectedAi.id) : [];
  const pendingChat = selectedAi ? pendingChats[selectedAi.id] : null;
  const showPending = Boolean(pendingChat);
  const selectedChatBusy = Boolean(pendingChat);
  const lastMessageId = messages.at(-1)?.id;

  const updateWasNearBottom = () => {
    const node = messagesRef.current;
    if (!node) {
      wasNearBottomRef.current = true;
      return;
    }

    wasNearBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= nearBottomScrollThreshold;
  };

  useLayoutEffect(() => {
    const node = messagesRef.current;
    if (!node) {
      return;
    }

    if (wasNearBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }

    updateWasNearBottom();
  }, [lastMessageId, messages.length, pendingChat?.message, selectedAi?.id, showPending]);

  useEffect(() => {
    if (!refocusAfterSend.current || busy || selectedChatBusy || !selectedAi || game.status !== "camp") {
      return;
    }

    inputRef.current?.focus();
    refocusAfterSend.current = false;
  }, [busy, game.status, selectedAi, selectedChatBusy]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message) {
      return;
    }
    refocusAfterSend.current = true;
    onSend(message);
    setDraft("");
  };

  return (
    <section className="panel chat-panel conversation-panel">
      <header className="panel-header">
        <div>
          <p className="eyebrow">Private chat</p>
          <h2>{selectedAi?.name ?? "Select an AI"}</h2>
        </div>
        <MessageCircle size={22} />
      </header>
      <div className="messages" onScroll={updateWasNearBottom} ref={messagesRef}>
        {selectedAi ? (
          messages.length > 0 || showPending ? (
            <>
              {messages.map((message) => (
                <div className={`bubble ${message.senderPlayerId === game.humanPlayerId ? "human" : "ai"}`} key={message.id}>
                  <strong>{playerName(game, message.senderPlayerId)}</strong>
                  <p>{chatBubbleContent(message.content)}</p>
                </div>
              ))}
              {showPending ? (
                <>
                  <div className="bubble human pending">
                    <strong>{playerName(game, game.humanPlayerId)}</strong>
                    <p>{pendingChat!.message}</p>
                  </div>
                  <div className="bubble ai typing">
                    <strong>{selectedAi!.name}</strong>
                    <LoadingDots label={`${selectedAi!.name} is typing`} />
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <div className="empty-state">No private conversation yet.</div>
          )
        ) : (
          <div className="empty-state">Pick a named active AI contestant from the cast.</div>
        )}
      </div>
      <form className="composer" onSubmit={submit}>
        <input
          ref={inputRef}
          disabled={!selectedAi || busy || selectedChatBusy || game.status !== "camp"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={selectedAi ? `Message ${selectedAi.name}` : "Select an AI first"}
          id="chat-message"
          name="chat-message"
        />
        <button type="submit" disabled={!selectedAi || busy || selectedChatBusy || game.status !== "camp" || !draft.trim()}>
          <Send size={18} />
        </button>
      </form>
      <DebugContextPanel context={selectedAi ? debugContext : null} />
    </section>
  );
};

const TribalChatPanel = ({
  game,
  selectedVote,
  onSelectVote,
  onAnswer,
  onVote,
  onReveal,
  busy,
  pendingAnswer,
  hiddenMessageIds,
  revealingMessages,
  displayRound,
}: {
  game: GameView;
  selectedVote: string;
  onSelectVote: (id: string) => void;
  onAnswer: (message: string) => void;
  onVote: () => void;
  onReveal: () => void;
  busy: boolean;
  pendingAnswer: PendingTribalAnswer | null;
  hiddenMessageIds: Set<string>;
  revealingMessages: boolean;
  displayRound: number;
}) => {
  const [tribalAnswer, setTribalAnswer] = useState("");
  const messagesRef = useRef<HTMLDivElement>(null);
  const wasNearBottomRef = useRef(true);
  const tribalMessages = game.messages.filter((message) => message.round === displayRound && message.channel === "tribal");
  const visibleTribalMessages = tribalMessages.filter((message) => !hiddenMessageIds.has(message.id));
  const revealedTally = voteTallyForRound(game, displayRound);
  const lastMessageId = visibleTribalMessages.at(-1)?.id;
  const serverHumanAnswered = tribalMessages.some((message) => message.senderPlayerId === game.humanPlayerId);
  const humanAnswerPending = pendingAnswer?.round === displayRound;
  const humanAnswered = serverHumanAnswered || humanAnswerPending;
  const isCurrentTribalRound = displayRound === game.round;
  const canVote = game.status === "tribal" && isCurrentTribalRound && serverHumanAnswered && !revealingMessages;
  const loadingLabel =
    game.status === "voting"
      ? "Revealing votes"
      : game.status === "tribal" || revealingMessages
        ? humanAnswered && selectedVote
          ? "Votes are being cast"
          : "Tribal Council is responding"
        : "Loading";

  const updateWasNearBottom = () => {
    const node = messagesRef.current;
    if (!node) {
      wasNearBottomRef.current = true;
      return;
    }

    wasNearBottomRef.current = node.scrollHeight - node.scrollTop - node.clientHeight <= nearBottomScrollThreshold;
  };

  useLayoutEffect(() => {
    const node = messagesRef.current;
    if (!node) {
      return;
    }

    if (wasNearBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }

    updateWasNearBottom();
  }, [lastMessageId, visibleTribalMessages.length, busy, game.status, humanAnswerPending, revealingMessages]);

  const submitAnswer = (event: FormEvent) => {
    event.preventDefault();
    const message = tribalAnswer.trim();
    if (!message) {
      return;
    }

    onAnswer(message);
    setTribalAnswer("");
  };

  return (
    <section className="panel chat-panel tribal-chat-panel">
      <header className="panel-header">
        <div>
          <p className="eyebrow">Tribal Council</p>
          <h2>Round {displayRound}</h2>
        </div>
        <Crown size={22} />
      </header>
      <div className="messages" onScroll={updateWasNearBottom} ref={messagesRef}>
        {tribalMessages.length > 0 || humanAnswerPending ? (
          <>
            {visibleTribalMessages.map((message) => {
              const sender = game.players.find((player) => player.id === message.senderPlayerId);
              const speakerKind = sender?.kind ?? "host";
              return (
                <div className={`bubble tribal ${speakerKind}`} key={message.id}>
                  <strong>{playerName(game, message.senderPlayerId)}</strong>
                  <p>{message.content}</p>
                </div>
              );
            })}
            {humanAnswerPending ? (
              <div className="bubble tribal human pending">
                <strong>{playerName(game, game.humanPlayerId)}</strong>
                <p>{pendingAnswer.message}</p>
              </div>
            ) : null}
            {(busy && (game.status === "tribal" || game.status === "voting")) || revealingMessages ? (
              <div className="bubble tribal typing">
                <strong>{loadingLabel}</strong>
                <LoadingDots label={loadingLabel} />
              </div>
            ) : null}
            {canVote ? (
              <div className="bubble tribal action-bubble">
                <strong>Cast your vote</strong>
                <div className="vote-composer inline">
                  <label>
                    Vote target
                    <select
                      id="vote-target"
                      name="vote-target"
                      value={selectedVote}
                      onChange={(event) => onSelectVote(event.target.value)}
                      disabled={busy}
                    >
                      <option value="">Choose</option>
                      {activeContestants(game)
                        .filter((player) => player.id !== game.humanPlayerId)
                        .map((player) => (
                          <option value={player.id} key={player.id}>
                            {player.name}
                          </option>
                        ))}
                    </select>
                  </label>
                  <button type="button" onClick={onVote} disabled={busy || !selectedVote}>
                    <Vote size={18} />
                    Vote
                  </button>
                </div>
              </div>
            ) : null}
            {game.status === "voting" && isCurrentTribalRound ? (
              <div className="bubble tribal action-bubble">
                <strong>Votes are locked in.</strong>
                <div className="vote-composer inline reveal-composer">
                  <span>Reveal the vote count.</span>
                  <button type="button" onClick={onReveal} disabled={busy}>
                    <Skull size={18} />
                    Reveal
                  </button>
                </div>
              </div>
            ) : null}
            {revealedTally ? (
              <div className="bubble tribal action-bubble">
                <div className="vote-results inline">
                  <strong>Round {revealedTally.round} vote count</strong>
                  {revealedTally.rows.map((row) => (
                    <span key={row.playerId || row.playerName}>
                      <span>{row.playerName}</span>
                      <b>{row.votes}</b>
                    </span>
                  ))}
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="empty-state">Tribal Council has not started.</div>
        )}
      </div>
      {game.status === "tribal" && isCurrentTribalRound && !humanAnswered ? (
        <form className="tribal-composer" onSubmit={submitAnswer}>
          <textarea
            id="tribal-answer"
            name="tribal-answer"
            value={tribalAnswer}
            onChange={(event) => setTribalAnswer(event.target.value)}
            disabled={busy}
            placeholder="Answer at Tribal Council"
            rows={3}
          />
          <button type="submit" disabled={busy || !tribalAnswer.trim()}>
            <Send size={18} />
            Answer
          </button>
        </form>
      ) : null}
    </section>
  );
};

const GameHeader = ({
  game,
  onTribal,
  busy,
}: {
  game: GameView;
  onTribal: () => void;
  busy: boolean;
}) => {
  const eliminated = game.events.filter((event) => event.type === "player_eliminated").at(-1);
  const headerRevealedRound = game.status === "camp" ? game.round - 1 : game.round;
  const revealedTally = voteTallyForRound(game, headerRevealedRound);
  const currentVoteCount = votesCastForCurrentRound(game);

  return (
    <header className="game-header">
      <div className="game-header-main">
        <Crown size={19} />
        <div>
          <p className="eyebrow">Round {game.round}</p>
          <strong>{game.status}</strong>
        </div>
      </div>
      <div className="game-header-meta">
        {currentVoteCount !== null ? <span>{currentVoteCount} votes cast</span> : null}
        {eliminated ? <span>Last eliminated: {String(eliminated.payload.playerName ?? "Unknown")}</span> : null}
        {revealedTally ? <span>Round {revealedTally.round} revealed</span> : null}
      </div>
      <div className="game-header-actions">
        <button type="button" onClick={onTribal} disabled={busy || game.status !== "camp"}>
          <Crown size={17} />
          Tribal
        </button>
      </div>
    </header>
  );
};

export const App = () => {
  const [game, setGame] = useState<GameView | null>(null);
  const [debugContexts, setDebugContexts] = useState<AiDebugContext[]>([]);
  const [recentGames, setRecentGames] = useState<RecentGame[]>(() => loadRecentGames());
  const [selectedAiId, setSelectedAiId] = useState<string | null>(null);
  const [selectedVote, setSelectedVote] = useState("");
  const [pendingChats, setPendingChats] = useState<PendingChats>({});
  const [pendingTribalAnswer, setPendingTribalAnswer] = useState<PendingTribalAnswer | null>(null);
  const [hiddenTribalMessageIds, setHiddenTribalMessageIds] = useState<Set<string>>(() => new Set());
  const [tribalRevealQueue, setTribalRevealQueue] = useState<string[]>([]);
  const [revealedRoundInChat, setRevealedRoundInChat] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasPendingChats = Object.keys(pendingChats).length > 0;
  const showTribalPanel = game ? isTribalPanelStatus(game.status) || revealedRoundInChat !== null : false;
  const tribalDisplayRound = game && revealedRoundInChat !== null ? revealedRoundInChat : (game?.round ?? 0);
  const revealingTribalMessages = hiddenTribalMessageIds.size > 0 || tribalRevealQueue.length > 0;

  useEffect(() => {
    if (tribalRevealQueue.length === 0) {
      return;
    }

    const timer = window.setTimeout(() => {
      const [nextMessageId] = tribalRevealQueue;

      setHiddenTribalMessageIds((current) => {
        const next = new Set(current);
        next.delete(nextMessageId);
        return next;
      });
      setTribalRevealQueue((current) => current.slice(1));
    }, 750);

    return () => window.clearTimeout(timer);
  }, [tribalRevealQueue]);

  const applyServerGame = (loadedGame: GameView, options: { preserveTribalStaging?: boolean } = {}) => {
    setGame(loadedGame);
    setRecentGames(rememberGame(loadedGame));
    setSelectedVote("");
    if (!options.preserveTribalStaging) {
      setPendingTribalAnswer(null);
      setHiddenTribalMessageIds(new Set());
      setTribalRevealQueue([]);
      setRevealedRoundInChat(null);
    }
    setSelectedAiId((current) => {
      if (current && loadedGame.players.some((player) => player.id === current && player.kind === "ai" && player.status === "active")) {
        return current;
      }

      return aiContestants(loadedGame)[0]?.id ?? null;
    });
  };

  const loadGameById = async (gameId: string) => {
    const [loadedGame, debugPayload] = await Promise.all([
      getGame(gameId),
      getDebugAiContexts(gameId).catch(() => ({ contexts: [] })),
    ]);
    applyServerGame(loadedGame);
    setDebugContexts(debugPayload.contexts);
    return loadedGame;
  };

  useEffect(() => {
    const loadFromUrl = () => {
      const gameId = gameIdFromPath();

      if (!gameId) {
        setGame(null);
        setDebugContexts([]);
        setRecentGames(loadRecentGames());
        setSelectedAiId(null);
        setSelectedVote("");
        setPendingChats({});
        setPendingTribalAnswer(null);
        setHiddenTribalMessageIds(new Set());
        setTribalRevealQueue([]);
        setRevealedRoundInChat(null);
        return;
      }

      setBusy(true);
      setError(null);
      loadGameById(gameId)
        .catch((err) => {
          setGame(null);
          setDebugContexts([]);
          setSelectedAiId(null);
          setPendingChats({});
          setError(err instanceof Error ? err.message : "Could not load game.");
        })
        .finally(() => setBusy(false));
    };

    loadFromUrl();
    window.addEventListener("popstate", loadFromUrl);

    return () => window.removeEventListener("popstate", loadFromUrl);
  }, []);

  const selectedAi = useMemo(() => {
    if (!game) {
      return null;
    }

    return game.players.find((player) => player.id === selectedAiId && player.kind === "ai") ?? aiContestants(game)[0] ?? null;
  }, [game, selectedAiId]);

  const selectedDebugContext = useMemo(() => {
    if (!selectedAi) {
      return null;
    }

    return debugContexts.find((context) => context.playerId === selectedAi.id) ?? null;
  }, [debugContexts, selectedAi]);

  const startGame = async (humanName: string, aiCount: number) => {
    setBusy(true);
    setError(null);
    try {
      const createdGame = await createGame({ humanName, aiCount });
      setGamePath(createdGame.id);
      await loadGameById(createdGame.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };

  const resumeGame = async (gameId: string) => {
    setBusy(true);
    setError(null);
    try {
      setGamePath(gameId);
      await loadGameById(gameId);
    } catch (err) {
      setGamePath(null);
      setError(err instanceof Error ? err.message : "Could not load game.");
    } finally {
      setBusy(false);
    }
  };

  const runServerAction = async (gameId: string, action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      await loadGameById(gameId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };

  const sendOptimisticChat = async (aiId: string, message: string) => {
    if (!game || pendingChats[aiId]) {
      return;
    }

    const gameId = game.id;
    setPendingChats((current) => {
      if (current[aiId]) {
        return current;
      }

      return { ...current, [aiId]: { aiId, message } };
    });
    setError(null);
    try {
      await sendChat(gameId, aiId, { message });
      await loadGameById(gameId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setPendingChats((current) => {
        const { [aiId]: _removed, ...remaining } = current;
        return remaining;
      });
    }
  };

  const revealVotesInChat = async () => {
    if (!game) {
      return;
    }

    const gameId = game.id;
    const revealedRound = game.round;
    setBusy(true);
    setError(null);
    try {
      const revealedGame = await revealVotes(gameId);
      applyServerGame(revealedGame, { preserveTribalStaging: true });
      setPendingTribalAnswer(null);
      setHiddenTribalMessageIds(new Set());
      setTribalRevealQueue([]);
      setRevealedRoundInChat(revealedRound);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };

  const sendOptimisticTribalAnswer = async (message: string) => {
    if (!game || pendingTribalAnswer) {
      return;
    }

    const gameId = game.id;
    const round = game.round;
    const existingTribalIds = new Set(
      game.messages.filter((item) => item.round === round && item.channel === "tribal").map((item) => item.id),
    );

    setBusy(true);
    setError(null);
    setPendingTribalAnswer({ round, message });
    setHiddenTribalMessageIds(new Set());
    setTribalRevealQueue([]);

    try {
      const answeredGame = await answerTribalCouncil(gameId, { message });
      const newAiMessageIds = answeredGame.messages
        .filter(
          (item) =>
            item.round === round &&
            item.channel === "tribal" &&
            !existingTribalIds.has(item.id) &&
            item.senderPlayerId !== answeredGame.humanPlayerId,
        )
        .map((item) => item.id);

      applyServerGame(answeredGame, { preserveTribalStaging: true });
      setPendingTribalAnswer(null);
      setHiddenTribalMessageIds(new Set(newAiMessageIds));
      setTribalRevealQueue(newAiMessageIds);
    } catch (err) {
      setPendingTribalAnswer(null);
      setError(err instanceof Error ? err.message : "Request failed.");
    } finally {
      setBusy(false);
    }
  };

  if (!game) {
    return (
      <>
        <Setup busy={busy} recentGames={recentGames} onCreate={startGame} onResume={resumeGame} />
        {error ? <div className="toast">{error}</div> : null}
      </>
    );
  }

  const eliminatedAiNames = game.players
    .filter((player) => player.kind === "ai" && player.status === "eliminated")
    .map((player) => player.name);
  const outlastedSummary =
    eliminatedAiNames.length > 0
      ? `You outlasted ${eliminatedAiNames.join(", ")}.`
      : "No named AI contestants were eliminated before the game ended.";

  return (
    <main className="app-shell">
      <GameHeader game={game} onTribal={() => runServerAction(game.id, () => advanceToTribal(game.id))} busy={busy || hasPendingChats} />
      <Roster
        game={game}
        selectedId={showTribalPanel ? null : (selectedAi?.id ?? null)}
        onSelect={(id) => {
          setRevealedRoundInChat(null);
          setSelectedAiId(id);
        }}
      />
      {showTribalPanel ? (
        <TribalChatPanel
          game={game}
          selectedVote={selectedVote}
          onSelectVote={setSelectedVote}
          onAnswer={sendOptimisticTribalAnswer}
          onVote={() => runServerAction(game.id, () => castVote(game.id, { targetId: selectedVote }))}
          onReveal={revealVotesInChat}
          busy={busy || hasPendingChats}
          pendingAnswer={pendingTribalAnswer}
          hiddenMessageIds={hiddenTribalMessageIds}
          revealingMessages={revealingTribalMessages}
          displayRound={tribalDisplayRound}
        />
      ) : (
        <ChatPanel
          game={game}
          selectedAi={selectedAi}
          debugContext={selectedDebugContext}
          busy={busy}
          pendingChats={pendingChats}
          onSend={(message) => selectedAi && sendOptimisticChat(selectedAi.id, message)}
        />
      )}
      {game.status === "complete" ? (
        <div className="result">
          <strong>Game complete</strong>
          <span>{outlastedSummary}</span>
        </div>
      ) : null}
      {error ? <div className="toast">{error}</div> : null}
    </main>
  );
};
