import { Crown, MessageCircle, Send, Skull, Users, Vote } from "lucide-react";
import { FormEvent, useEffect, useMemo, useState } from "react";
import { advanceToTribal, castVote, createGame, getGame, revealVotes, sendChat } from "./engine/client";
import type { GameMessage, GameView, PlayerSummary } from "./shared/types";

const playerName = (game: GameView | null, playerId: string | null) => {
  if (!game || !playerId) {
    return "System";
  }

  return game.players.find((player) => player.id === playerId)?.name ?? "Unknown";
};

const activePlayers = (game: GameView) => game.players.filter((player) => player.kind !== "host" && player.status === "active");

const aiPlayers = (game: GameView) => game.players.filter((player) => player.kind === "ai" && player.status === "active");

const privateMessagesFor = (messages: GameMessage[], humanId: string, aiId: string) =>
  messages.filter(
    (message) =>
      message.channel === "private" &&
      ((message.senderPlayerId === humanId && message.recipientPlayerId === aiId) ||
        (message.senderPlayerId === aiId && message.recipientPlayerId === humanId)),
  );

type PendingChat = {
  aiId: string;
  message: string;
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

const Setup = ({ onCreate, busy }: { onCreate: (name: string, aiCount: number) => void; busy: boolean }) => {
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
          <p className="lede">One human enters a live social vote against a cast of persistent AI players.</p>
        </div>
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
    <div className="players">
      {game.players
        .filter((player) => player.kind !== "host")
        .map((player) => (
          <button
            className={`player ${selectedId === player.id ? "selected" : ""} ${player.status}`}
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
              <span className="player-card" role="tooltip">
                <strong>{player.profile.archetype}</strong>
                <span>{player.profile.biography}</span>
                <span>Speech: {player.profile.speechStyle}</span>
                <span>Strategy: {player.profile.strategicStyle}</span>
                <span>
                  Loyalty {player.profile.loyalty} · Deception {player.profile.deception} · Threat sense {player.profile.threatSensitivity}
                </span>
              </span>
            ) : null}
            {player.status === "eliminated" ? <Skull size={16} /> : null}
          </button>
        ))}
    </div>
  </aside>
);

const ChatPanel = ({
  game,
  selectedAi,
  busy,
  pendingChat,
  onSend,
}: {
  game: GameView;
  selectedAi: PlayerSummary | null;
  busy: boolean;
  pendingChat: PendingChat | null;
  onSend: (message: string) => void;
}) => {
  const [draft, setDraft] = useState("");
  const messages = selectedAi ? privateMessagesFor(game.messages, game.humanPlayerId, selectedAi.id) : [];
  const showPending = Boolean(selectedAi && pendingChat?.aiId === selectedAi.id);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = draft.trim();
    if (!message) {
      return;
    }
    onSend(message);
    setDraft("");
  };

  return (
    <section className="panel chat-panel">
      <header className="panel-header">
        <div>
          <p className="eyebrow">Private chat</p>
          <h2>{selectedAi?.name ?? "Select an AI"}</h2>
        </div>
        <MessageCircle size={22} />
      </header>
      <div className="messages">
        {selectedAi ? (
          messages.length > 0 || showPending ? (
            <>
              {messages.map((message) => (
                <div className={`bubble ${message.senderPlayerId === game.humanPlayerId ? "human" : "ai"}`} key={message.id}>
                  <strong>{playerName(game, message.senderPlayerId)}</strong>
                  <p>{message.content}</p>
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
                    <span className="typing-dots" aria-label={`${selectedAi!.name} is typing`}>
                      <span />
                      <span />
                      <span />
                    </span>
                  </div>
                </>
              ) : null}
            </>
          ) : (
            <div className="empty-state">No private conversation yet.</div>
          )
        ) : (
          <div className="empty-state">Pick an active AI player from the cast.</div>
        )}
      </div>
      <form className="composer" onSubmit={submit}>
        <input
          disabled={!selectedAi || busy || game.status === "complete"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={selectedAi ? `Message ${selectedAi.name}` : "Select an AI first"}
          id="chat-message"
          name="chat-message"
        />
        <button type="submit" disabled={!selectedAi || busy || !draft.trim()}>
          <Send size={18} />
        </button>
      </form>
    </section>
  );
};

const TribalPanel = ({
  game,
  selectedVote,
  onSelectVote,
  onTribal,
  onVote,
  onReveal,
  busy,
}: {
  game: GameView;
  selectedVote: string;
  onSelectVote: (id: string) => void;
  onTribal: () => void;
  onVote: () => void;
  onReveal: () => void;
  busy: boolean;
}) => {
  const currentVotes = game.votes.filter((vote) => vote.round === game.round);
  const eliminated = game.events.filter((event) => event.type === "player_eliminated").at(-1);

  return (
    <aside className="rail council">
      <div className="rail-title">
        <Crown size={18} />
        <span>Round {game.round}</span>
      </div>
      <div className="status-strip">
        <span>Status</span>
        <strong>{game.status}</strong>
      </div>
      <div className="tribal-actions">
        <button type="button" onClick={onTribal} disabled={busy || game.status !== "camp"}>
          <Crown size={17} />
          Tribal
        </button>
        <label>
          Vote target
          <select
            id="vote-target"
            name="vote-target"
            value={selectedVote}
            onChange={(event) => onSelectVote(event.target.value)}
            disabled={busy || game.status === "complete"}
          >
            <option value="">Choose</option>
            {activePlayers(game)
              .filter((player) => player.id !== game.humanPlayerId)
              .map((player) => (
                <option value={player.id} key={player.id}>
                  {player.name}
                </option>
              ))}
          </select>
        </label>
        <button type="button" onClick={onVote} disabled={busy || !selectedVote || game.status === "complete"}>
          <Vote size={17} />
          Vote
        </button>
        <button type="button" onClick={onReveal} disabled={busy || currentVotes.length === 0 || game.status === "complete"}>
          <Skull size={17} />
          Reveal
        </button>
      </div>
      <div className="timeline">
        {game.messages
          .filter((message) => message.channel === "tribal")
          .slice(-2)
          .map((message) => (
            <p key={message.id}>{message.content}</p>
          ))}
        {currentVotes.length > 0 ? <p>{currentVotes.length} votes cast this round.</p> : null}
        {eliminated ? <p>Last eliminated: {String(eliminated.payload.playerName ?? "Unknown")}</p> : null}
      </div>
    </aside>
  );
};

export const App = () => {
  const [game, setGame] = useState<GameView | null>(null);
  const [selectedAiId, setSelectedAiId] = useState<string | null>(null);
  const [selectedVote, setSelectedVote] = useState("");
  const [pendingChat, setPendingChat] = useState<PendingChat | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const applyServerGame = (loadedGame: GameView) => {
    setGame(loadedGame);
    setSelectedVote("");
    setSelectedAiId((current) => {
      if (current && loadedGame.players.some((player) => player.id === current && player.kind === "ai" && player.status === "active")) {
        return current;
      }

      return aiPlayers(loadedGame)[0]?.id ?? null;
    });
  };

  const loadGameById = async (gameId: string) => {
    const loadedGame = await getGame(gameId);
    applyServerGame(loadedGame);
    return loadedGame;
  };

  useEffect(() => {
    const loadFromUrl = () => {
      const gameId = gameIdFromPath();

      if (!gameId) {
        setGame(null);
        setSelectedAiId(null);
        setSelectedVote("");
        return;
      }

      setBusy(true);
      setError(null);
      loadGameById(gameId)
        .catch((err) => {
          setGame(null);
          setSelectedAiId(null);
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

    return game.players.find((player) => player.id === selectedAiId && player.kind === "ai") ?? aiPlayers(game)[0] ?? null;
  }, [game, selectedAiId]);

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
    if (!game) {
      return;
    }

    try {
      setPendingChat({ aiId, message });
      await runServerAction(game.id, () => sendChat(game.id, aiId, { message }));
    } finally {
      setPendingChat(null);
    }
  };

  if (!game) {
    return (
      <>
        <Setup busy={busy} onCreate={startGame} />
        {error ? <div className="toast">{error}</div> : null}
      </>
    );
  }

  return (
    <main className="app-shell">
      <Roster game={game} selectedId={selectedAi?.id ?? null} onSelect={setSelectedAiId} />
      <ChatPanel
        game={game}
        selectedAi={selectedAi}
        busy={busy}
        pendingChat={pendingChat}
        onSend={(message) => selectedAi && sendOptimisticChat(selectedAi.id, message)}
      />
      <TribalPanel
        game={game}
        selectedVote={selectedVote}
        onSelectVote={setSelectedVote}
        onTribal={() => runServerAction(game.id, () => advanceToTribal(game.id))}
        onVote={() => runServerAction(game.id, () => castVote(game.id, { targetId: selectedVote }))}
        onReveal={() => runServerAction(game.id, () => revealVotes(game.id))}
        busy={busy}
      />
      {game.status === "complete" ? (
        <div className="result">
          <strong>Game complete</strong>
          <span>You outlasted {game.players.filter((player) => player.kind === "ai" && player.status === "eliminated").length} AI players.</span>
        </div>
      ) : null}
      {error ? <div className="toast">{error}</div> : null}
    </main>
  );
};
