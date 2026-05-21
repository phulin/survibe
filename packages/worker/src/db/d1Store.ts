import type {
  AiProfile,
  GameEvent,
  GameMessage,
  GameStatus,
  GameView,
  MessageChannel,
  PlayerKind,
  PlayerStatus,
  PlayerSummary,
  VoteRecord,
} from "@survibe/shared";
import { selectCast } from "../game/cast";

type GameRow = {
  id: string;
  status: GameStatus;
  round: number;
  human_player_id: string | null;
  created_at: string;
  updated_at: string;
};

type PlayerRow = {
  id: string;
  game_id: string;
  kind: PlayerKind;
  name: string;
  status: PlayerStatus;
  placement: number | null;
  profile_json: string | null;
  public_facts_json: string;
  private_notes_json: string;
};

type MessageRow = {
  id: string;
  game_id: string;
  round: number;
  channel: MessageChannel;
  sender_player_id: string | null;
  recipient_player_id: string | null;
  content: string;
  created_at: string;
};

type VoteRow = {
  id: string;
  round: number;
  voter_id: string;
  target_id: string;
  rationale: string;
  confidence: number;
  created_at: string;
};

type EventRow = {
  id: string;
  round: number;
  type: string;
  payload_json: string;
  created_at: string;
};

const parseJson = <T>(value: string | null, fallback: T): T => {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

const nowIso = () => new Date().toISOString();

const humanContestantProfile = (name: string): AiProfile => ({
  archetype: "The Connector",
  biography: `${name} presents as a socially fluent strategist who prioritizes early bonds and flexible voting options.`,
  speechStyle: "Warm, curious, and relationship-focused.",
  strategicStyle: "Builds trust early, asks direct questions, and looks for stable numbers before Tribal Council.",
  riskTolerance: "medium",
  loyalty: 64,
  deception: 52,
  threatSensitivity: 66,
  memorySummary: `${name} is trying to establish enough trust to survive the first votes without appearing too threatening.`,
});

const toPlayer = (row: PlayerRow): PlayerSummary => ({
  id: row.id,
  kind: row.kind,
  name: row.name,
  status: row.status,
  placement: row.placement,
  profile: parseJson<AiProfile | null>(row.profile_json, null),
  publicFacts: parseJson<string[]>(row.public_facts_json, []),
  privateNotes: parseJson<string[]>(row.private_notes_json, []),
});

const toMessage = (row: MessageRow): GameMessage => ({
  id: row.id,
  gameId: row.game_id,
  round: row.round,
  channel: row.channel,
  senderPlayerId: row.sender_player_id,
  recipientPlayerId: row.recipient_player_id,
  content: row.content,
  createdAt: row.created_at,
});

const toVote = (row: VoteRow): VoteRecord => ({
  id: row.id,
  round: row.round,
  voterId: row.voter_id,
  targetId: row.target_id,
  rationale: row.rationale,
  confidence: row.confidence,
  createdAt: row.created_at,
});

const toEvent = (row: EventRow): GameEvent => ({
  id: row.id,
  round: row.round,
  type: row.type,
  payload: parseJson<Record<string, unknown>>(row.payload_json, {}),
  createdAt: row.created_at,
});

export const createGame = async (db: D1Database, humanName: string, aiCount: number) => {
  const gameId = crypto.randomUUID();
  const humanId = crypto.randomUUID();
  const hostId = crypto.randomUUID();
  const createdAt = nowIso();
  const cast = selectCast(aiCount);
  const playerName = humanName || "Alex Vale";

  await db
    .prepare("INSERT INTO games (id, status, round, human_player_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(gameId, "camp", 1, humanId, createdAt, createdAt)
    .run();

  await db
    .prepare(
      "INSERT INTO players (id, game_id, kind, name, status, profile_json, public_facts_json, private_notes_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(
      humanId,
      gameId,
      "human",
      playerName,
      "active",
      JSON.stringify(humanContestantProfile(playerName)),
      JSON.stringify(["The Connector"]),
      "[]",
      createdAt,
      createdAt,
    )
    .run();

  await db
    .prepare(
      "INSERT INTO players (id, game_id, kind, name, status, public_facts_json, private_notes_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(hostId, gameId, "host", "Jeff Probst", "active", "[]", "[]", createdAt, createdAt)
    .run();

  for (const profile of cast) {
    await db
      .prepare(
        "INSERT INTO players (id, game_id, kind, name, status, profile_json, public_facts_json, private_notes_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(
        crypto.randomUUID(),
        gameId,
        "ai",
        profile.name,
        "active",
        JSON.stringify(profile),
        JSON.stringify([profile.archetype]),
        "[]",
        createdAt,
        createdAt,
      )
      .run();
  }

  await addEvent(db, gameId, 1, "game_started", {
    contestants: [playerName, ...cast.map((profile) => profile.name)],
    aiCount: cast.length,
  });

  return getGame(db, gameId);
};

export const getGame = async (db: D1Database, gameId: string): Promise<GameView | null> => {
  const game = await db.prepare("SELECT * FROM games WHERE id = ?").bind(gameId).first<GameRow>();

  if (!game || !game.human_player_id) {
    return null;
  }

  const players = await db
    .prepare("SELECT * FROM players WHERE game_id = ? ORDER BY kind DESC, name ASC")
    .bind(gameId)
    .all<PlayerRow>();
  const messages = await db
    .prepare("SELECT * FROM messages WHERE game_id = ? ORDER BY created_at ASC")
    .bind(gameId)
    .all<MessageRow>();
  const votes = await db
    .prepare("SELECT * FROM votes WHERE game_id = ? ORDER BY created_at ASC")
    .bind(gameId)
    .all<VoteRow>();
  const events = await db
    .prepare("SELECT * FROM game_events WHERE game_id = ? ORDER BY created_at ASC")
    .bind(gameId)
    .all<EventRow>();

  return {
    id: game.id,
    status: game.status,
    round: game.round,
    humanPlayerId: game.human_player_id,
    createdAt: game.created_at,
    updatedAt: game.updated_at,
    players: players.results.map(toPlayer),
    messages: messages.results.map(toMessage),
    votes: votes.results.map(toVote),
    events: events.results.map(toEvent),
  };
};

export const addMessage = async (
  db: D1Database,
  gameId: string,
  round: number,
  channel: MessageChannel,
  senderPlayerId: string | null,
  recipientPlayerId: string | null,
  content: string,
) => {
  const createdAt = nowIso();

  await db
    .prepare(
      "INSERT INTO messages (id, game_id, round, channel, sender_player_id, recipient_player_id, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), gameId, round, channel, senderPlayerId, recipientPlayerId, content, createdAt)
    .run();
};

export const updateGameStatus = async (db: D1Database, gameId: string, status: GameStatus, round?: number) => {
  const updatedAt = nowIso();

  if (round) {
    await db.prepare("UPDATE games SET status = ?, round = ?, updated_at = ? WHERE id = ?").bind(status, round, updatedAt, gameId).run();
    return;
  }

  await db.prepare("UPDATE games SET status = ?, updated_at = ? WHERE id = ?").bind(status, updatedAt, gameId).run();
};

export const addEvent = async (db: D1Database, gameId: string, round: number, type: string, payload: Record<string, unknown>) => {
  await db
    .prepare("INSERT INTO game_events (id, game_id, round, type, payload_json, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), gameId, round, type, JSON.stringify(payload), nowIso())
    .run();
};

export const addVote = async (
  db: D1Database,
  gameId: string,
  round: number,
  voterId: string,
  targetId: string,
  rationale: string,
  confidence: number,
) => {
  let council = await db
    .prepare("SELECT id FROM tribal_councils WHERE game_id = ? AND round = ?")
    .bind(gameId, round)
    .first<{ id: string }>();

  if (!council) {
    const councilId = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO tribal_councils (id, game_id, round, status, transcript_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(councilId, gameId, round, "voting", "[]", nowIso(), nowIso())
      .run();
    council = { id: councilId };
  }

  await db
    .prepare(
      "INSERT OR REPLACE INTO votes (id, game_id, tribal_council_id, round, voter_id, target_id, rationale, confidence, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(crypto.randomUUID(), gameId, council.id, round, voterId, targetId, rationale, confidence, nowIso())
    .run();
};

export const eliminatePlayer = async (db: D1Database, playerId: string, placement: number) => {
  await db
    .prepare("UPDATE players SET status = ?, placement = ?, updated_at = ? WHERE id = ?")
    .bind("eliminated", placement, nowIso(), playerId)
    .run();
};
