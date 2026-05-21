import type { ChatRequest, CreateGameRequest, GameEvent, GameView, TribalAnswerRequest, VoteRequest } from "@survibe/shared";
import { generateAiPrivateTurn, generateAiTribalAnswer, generateAiVote, generateJeffTribalQuestion } from "./ai/openaiClient";
import { addEvent, addMessage, addVote, createGame, eliminatePlayer, getGame, updateGameStatus } from "./db/d1Store";
import { activeAiPlayers, activeContestants, assertActiveTarget, findPlayer, getPlacement, shouldEndGame } from "./game/rules";

export interface Env {
  DB: D1Database;
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
  APP_ENV: string;
}

type RouteParams = {
  gameId?: string;
  playerId?: string;
};

const json = (body: unknown, init: ResponseInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-allow-headers", "content-type");

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
};

const notFound = () => json({ error: "Not found" }, { status: 404 });

const badRequest = (message: string) => json({ error: message }, { status: 400 });

const tribalQuestion = "The social game is over for tonight. The vote is about trust, threat level, and who can survive one more round.";
const maxAiPrivateTurnsPerRequest = 8;
const maxAiPrivateToolDepth = 2;

const readJson = async <T>(request: Request): Promise<T> => {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
};

const matchRoute = (pathname: string, pattern: RegExp): RouteParams | null => {
  const match = pattern.exec(pathname);

  if (!match?.groups) {
    return null;
  }

  return match.groups;
};

const voteTallyForRound = (game: GameView, round: number) => {
  const tally = new Map<string, number>();
  const roundVotes = game.votes.filter((vote) => vote.round === round);

  for (const vote of roundVotes) {
    tally.set(vote.targetId, (tally.get(vote.targetId) ?? 0) + 1);
  }

  return game.players
    .filter((player) => player.kind !== "host")
    .map((player) => ({
      playerId: player.id,
      playerName: player.name,
      votes: tally.get(player.id) ?? 0,
    }))
    .filter((row) => row.votes > 0 || roundVotes.some((vote) => vote.targetId === row.playerId))
    .sort((a, b) => b.votes - a.votes || a.playerName.localeCompare(b.playerName));
};

const humanVisibleEvents = (game: GameView): GameEvent[] =>
  game.events.map((event) => {
    if (event.type === "player_eliminated" && !Array.isArray(event.payload.voteTally)) {
      return {
        ...event,
        payload: {
          ...event.payload,
          voteTally: voteTallyForRound(game, event.round),
          totalVotes: game.votes.filter((vote) => vote.round === event.round).length,
        },
      };
    }

    if (event.type === "votes_cast" && typeof event.payload.totalVotes !== "number") {
      return {
        ...event,
        payload: {
          ...event.payload,
          totalVotes: game.votes.filter((vote) => vote.round === event.round).length,
        },
      };
    }

    return event;
  });

const humanVisibleGame = (game: GameView): GameView => ({
  ...game,
  players: game.players.map((player) => ({
    ...player,
    privateNotes: [],
    profile: player.profile
      ? {
          ...player.profile,
          riskTolerance: "medium",
          loyalty: 0,
          deception: 0,
          threatSensitivity: 0,
          memorySummary: "",
        }
      : null,
  })),
  messages: game.messages.filter(
    (message) =>
      message.channel !== "private" ||
      message.senderPlayerId === game.humanPlayerId ||
      message.recipientPlayerId === game.humanPlayerId,
  ),
  votes: [],
  events: humanVisibleEvents(game),
});

const jsonGame = (game: GameView | null, init?: ResponseInit) => (game ? json(humanVisibleGame(game), init) : notFound());

const chooseAiTarget = (voterId: string, candidates: string[], round: number) => {
  const seed = [...voterId].reduce((sum, char) => sum + char.charCodeAt(0), round);
  return candidates[seed % candidates.length];
};

const hostPlayer = (game: GameView) => game.players.find((player) => player.kind === "host") ?? null;

const currentTribalQuestion = (game: GameView) => {
  const hostId = hostPlayer(game)?.id ?? null;
  return (
    [...game.messages]
      .reverse()
      .find((message) => message.round === game.round && message.channel === "tribal" && message.senderPlayerId === hostId)?.content ??
    tribalQuestion
  );
};

const revealVotes = async (env: Env, gameId: string) => {
  const game = await getGame(env.DB, gameId);

  if (!game) {
    return notFound();
  }

  if (game.status !== "voting") {
    return badRequest("Votes can only be revealed after voting.");
  }

  const roundVotes = game.votes.filter((vote) => vote.round === game.round);

  if (roundVotes.length === 0) {
    return badRequest("No votes have been cast.");
  }
  if (roundVotes.length < activeContestants(game.players).length) {
    return badRequest("Not every active player has voted.");
  }

  const tally = new Map<string, number>();
  for (const vote of roundVotes) {
    tally.set(vote.targetId, (tally.get(vote.targetId) ?? 0) + 1);
  }
  const voteTally = activeContestants(game.players)
    .map((player) => ({
      playerId: player.id,
      playerName: player.name,
      votes: tally.get(player.id) ?? 0,
    }))
    .sort((a, b) => b.votes - a.votes || a.playerName.localeCompare(b.playerName));

  const [eliminatedId] = [...tally.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
  const eliminated = assertActiveTarget(game, eliminatedId);
  const placement = getPlacement(game.players);

  await eliminatePlayer(env.DB, eliminatedId, placement);
  await addEvent(env.DB, game.id, game.round, "player_eliminated", {
    playerId: eliminatedId,
    playerName: eliminated.name,
    placement,
    voteCount: tally.get(eliminatedId) ?? 0,
    voteTally,
    totalVotes: roundVotes.length,
  });

  const refreshed = await getGame(env.DB, game.id);
  if (!refreshed) {
    return notFound();
  }

  if (eliminatedId === refreshed.humanPlayerId || shouldEndGame(refreshed.players)) {
    await updateGameStatus(env.DB, game.id, "complete");
  } else {
    const nextRound = game.round + 1;
    await updateGameStatus(env.DB, game.id, "camp", nextRound);
    await addEvent(env.DB, game.id, nextRound, "round_started", {
      contestants: activeContestants(refreshed.players).map((player) => player.name),
    });
  }

  return jsonGame(await getGame(env.DB, game.id));
};

const castAiVotes = async (env: Env, gameId: string) => {
  const game = await getGame(env.DB, gameId);

  if (!game) {
    return notFound();
  }

  const contestants = activeContestants(game.players);
  const aiPlayers = activeAiPlayers(game.players);

  for (const ai of aiPlayers) {
    const alreadyVoted = game.votes.some((vote) => vote.round === game.round && vote.voterId === ai.id);
    if (alreadyVoted) {
      continue;
    }

    const candidates = contestants.filter((player) => player.id !== ai.id);
    const fallbackTargetId = chooseAiTarget(
      ai.id,
      candidates.map((player) => player.id),
      game.round,
    );
    let decision = {
      targetId: fallbackTargetId,
      rationale: "Best available target.",
      confidence: 68,
    };

    try {
      decision = await generateAiVote(env, game, ai, candidates);
    } catch {
      const fallbackTarget = findPlayer(game, fallbackTargetId);
      decision = {
        targetId: fallbackTargetId,
        rationale: fallbackTarget ? `${fallbackTarget.name} is the most practical vote for me tonight.` : "Best available target.",
        confidence: 60,
      };
    }

    if (decision.targetId === ai.id || !candidates.some((candidate) => candidate.id === decision.targetId)) {
      decision.targetId = fallbackTargetId;
    }

    const targetId = decision.targetId;
    const target = findPlayer(game, targetId);

    await addVote(
      env.DB,
      game.id,
      game.round,
      ai.id,
      targetId,
      decision.rationale || (target ? `${target.name} looks like the cleanest way through this vote.` : "Best available target."),
      decision.confidence,
    );
  }
};

type PendingAiPrivateMessage = {
  senderId: string;
  recipientId: string;
  content: string;
  messageId: string | null;
  depth: number;
};

const processAiPrivateTurns = async (env: Env, gameId: string, initialMessages: PendingAiPrivateMessage[]) => {
  const queue = [...initialMessages];
  let processed = 0;

  while (queue.length > 0 && processed < maxAiPrivateTurnsPerRequest) {
    const incoming = queue.shift()!;
    const game = await getGame(env.DB, gameId);

    if (!game || game.status !== "camp") {
      break;
    }

    const ai = findPlayer(game, incoming.recipientId);
    const sender = findPlayer(game, incoming.senderId);

    if (!ai || ai.kind !== "ai" || ai.status !== "active" || !sender || sender.kind === "host" || sender.status !== "active") {
      continue;
    }

    const messageCandidates = activeContestants(game.players).filter(
      (player) => player.id !== ai.id && player.id !== sender.id && player.status === "active",
    );

    let turn;
    try {
      turn = await generateAiPrivateTurn(env, game, ai, sender, incoming.content, incoming.messageId, messageCandidates);
    } catch {
      turn = {
        reply: "I hear you. I need to compare that with what everyone else is saying before I lock anything in.",
        toolCalls: [],
      };
    }

    const reply = turn.reply?.trim() ?? "";
    const replyMessage = reply ? await addMessage(env.DB, game.id, game.round, "private", ai.id, sender.id, reply) : null;
    processed += 1;

    if (incoming.depth >= maxAiPrivateToolDepth) {
      continue;
    }

    if (sender.kind === "ai" && replyMessage) {
      queue.push({
        senderId: ai.id,
        recipientId: sender.id,
        content: reply,
        messageId: replyMessage.id,
        depth: incoming.depth + 1,
      });
    }

    const refreshed = await getGame(env.DB, gameId);
    if (!refreshed || refreshed.status !== "camp") {
      break;
    }

    const latestCandidates = activeContestants(refreshed.players).filter(
      (player) => player.id !== ai.id && player.id !== sender.id && player.status === "active",
    );

    for (const toolCall of turn.toolCalls) {
      const recipient = latestCandidates.find((player) => player.name.toLowerCase() === toolCall.recipientName.toLowerCase());
      if (!recipient) {
        continue;
      }

      const toolMessage = await addMessage(env.DB, refreshed.id, refreshed.round, "private", ai.id, recipient.id, toolCall.message);
      if (recipient.kind === "ai") {
        queue.push({
          senderId: ai.id,
          recipientId: recipient.id,
          content: toolCall.message,
          messageId: toolMessage.id,
          depth: incoming.depth + 1,
        });
      }
    }
  }
};

const addAiTribalAnswers = async (env: Env, gameId: string, question: string) => {
  let game = await getGame(env.DB, gameId);

  if (!game) {
    return null;
  }

  for (const ai of activeAiPlayers(game.players)) {
    const round = game.round;
    const messages = game.messages;
    const alreadyAnswered = messages.some(
      (message) => message.round === round && message.channel === "tribal" && message.senderPlayerId === ai.id,
    );
    if (alreadyAnswered) {
      continue;
    }

    let answer = "Tonight, I am weighing what people have said against what actually protects my game.";
    try {
      answer = await generateAiTribalAnswer(env, game, ai, question);
    } catch {
      const profile = ai.profile?.strategicStyle;
      answer = profile ? `${profile}. Tonight, I need a vote that leaves me with room to keep playing.` : answer;
    }
    await addMessage(env.DB, game.id, game.round, "tribal", ai.id, null, answer);
    game = await getGame(env.DB, gameId);

    if (!game) {
      return null;
    }
  }

  if (!game) {
    return null;
  }

  await addEvent(env.DB, game.id, game.round, "tribal_answers_completed", {
    round: game.round,
  });

  return getGame(env.DB, gameId);
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return json({}, { status: 204 });
    }

    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        const dbCheck = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();

        return json({
          ok: true,
          appEnv: env.APP_ENV,
          database: dbCheck?.ok === 1 ? "reachable" : "unknown",
        });
      }

      if (request.method === "POST" && url.pathname === "/api/games") {
        const body = await readJson<CreateGameRequest>(request);
        const humanName = body.humanName?.trim() || "Castaway";
        const aiCount = Number.isFinite(body.aiCount) ? body.aiCount : 6;
        return jsonGame(await createGame(env.DB, humanName, aiCount), { status: 201 });
      }

      const gameMatch = matchRoute(url.pathname, /^\/api\/games\/(?<gameId>[^/]+)$/);
      if (request.method === "GET" && gameMatch?.gameId) {
        const game = await getGame(env.DB, gameMatch.gameId);
        return jsonGame(game);
      }

      const chatMatch = matchRoute(url.pathname, /^\/api\/games\/(?<gameId>[^/]+)\/chat\/(?<playerId>[^/]+)$/);
      if (request.method === "POST" && chatMatch?.gameId && chatMatch.playerId) {
        const game = await getGame(env.DB, chatMatch.gameId);
        if (!game) {
          return notFound();
        }
        if (game.status !== "camp") {
          return badRequest("Private messages can only be sent at camp.");
        }

        const ai = findPlayer(game, chatMatch.playerId);
        const human = findPlayer(game, game.humanPlayerId);
        if (!ai || ai.kind !== "ai" || ai.status !== "active" || !human) {
          return badRequest("Chat target must be an active AI player.");
        }

        const body = await readJson<ChatRequest>(request);
        const humanMessage = body.message?.trim();
        if (!humanMessage) {
          return badRequest("Message is required.");
        }

        const message = await addMessage(env.DB, game.id, game.round, "private", human.id, ai.id, humanMessage);
        await processAiPrivateTurns(env, game.id, [
          {
            senderId: human.id,
            recipientId: ai.id,
            content: humanMessage,
            messageId: message.id,
            depth: 0,
          },
        ]);

        return jsonGame(await getGame(env.DB, game.id));
      }

      const tribalMatch = matchRoute(url.pathname, /^\/api\/games\/(?<gameId>[^/]+)\/advance-to-tribal$/);
      if (request.method === "POST" && tribalMatch?.gameId) {
        const game = await getGame(env.DB, tribalMatch.gameId);
        if (!game) {
          return notFound();
        }
        if (game.status !== "camp") {
          return badRequest("Can only advance to Tribal Council from camp.");
        }

        const host = hostPlayer(game);
        let question = tribalQuestion;
        if (host) {
          try {
            question = await generateJeffTribalQuestion(env, game, host);
          } catch {
            question = tribalQuestion;
          }
        }

        await updateGameStatus(env.DB, game.id, "tribal");
        await addEvent(env.DB, game.id, game.round, "tribal_started", {
          prompt: question,
        });
        await addMessage(
          env.DB,
          game.id,
          game.round,
          "tribal",
          host?.id ?? null,
          null,
          question,
        );

        return jsonGame(await getGame(env.DB, game.id));
      }

      const tribalAnswerMatch = matchRoute(url.pathname, /^\/api\/games\/(?<gameId>[^/]+)\/tribal-answer$/);
      if (request.method === "POST" && tribalAnswerMatch?.gameId) {
        const game = await getGame(env.DB, tribalAnswerMatch.gameId);
        if (!game) {
          return notFound();
        }
        if (game.status !== "tribal") {
          return badRequest("Can only answer during Tribal Council.");
        }

        const human = findPlayer(game, game.humanPlayerId);
        if (!human || human.status !== "active") {
          return badRequest("Only an active player can answer at Tribal Council.");
        }

        const alreadyAnswered = game.messages.some(
          (message) => message.round === game.round && message.channel === "tribal" && message.senderPlayerId === human.id,
        );
        if (alreadyAnswered) {
          return badRequest("You have already answered at this Tribal Council.");
        }

        const body = await readJson<TribalAnswerRequest>(request);
        const answer = body.message?.trim();
        if (!answer) {
          return badRequest("Answer is required.");
        }

        await addMessage(env.DB, game.id, game.round, "tribal", human.id, null, answer);
        const refreshed = await addAiTribalAnswers(env, game.id, currentTribalQuestion(game));

        return jsonGame(refreshed);
      }

      const voteMatch = matchRoute(url.pathname, /^\/api\/games\/(?<gameId>[^/]+)\/vote$/);
      if (request.method === "POST" && voteMatch?.gameId) {
        const game = await getGame(env.DB, voteMatch.gameId);
        if (!game) {
          return notFound();
        }
        if (game.status !== "tribal") {
          return badRequest("Can only vote after Tribal Council answers.");
        }

        const body = await readJson<VoteRequest>(request);
        const target = assertActiveTarget(game, body.targetId);
        if (target.id === game.humanPlayerId) {
          return badRequest("You cannot vote for yourself.");
        }

        const humanAnswered = game.messages.some(
          (message) => message.round === game.round && message.channel === "tribal" && message.senderPlayerId === game.humanPlayerId,
        );
        if (!humanAnswered) {
          return badRequest("Answer at Tribal Council before voting.");
        }

        const alreadyVoted = game.votes.some((vote) => vote.round === game.round && vote.voterId === game.humanPlayerId);
        if (alreadyVoted) {
          return badRequest("You have already voted this round.");
        }

        await addVote(env.DB, game.id, game.round, game.humanPlayerId, target.id, `Voted for ${target.name}.`, 100);
        await castAiVotes(env, game.id);
        await updateGameStatus(env.DB, game.id, "voting");
        await addEvent(env.DB, game.id, game.round, "votes_cast", {
          round: game.round,
          totalVotes: activeContestants(game.players).length,
        });

        return jsonGame(await getGame(env.DB, game.id));
      }

      const revealMatch = matchRoute(url.pathname, /^\/api\/games\/(?<gameId>[^/]+)\/reveal$/);
      if (request.method === "POST" && revealMatch?.gameId) {
        return revealVotes(env, revealMatch.gameId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected error.";
      return json({ error: message }, { status: 500 });
    }

    return notFound();
  },
} satisfies ExportedHandler<Env>;
