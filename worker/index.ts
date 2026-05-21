import type { ChatRequest, CreateGameRequest, VoteRequest } from "../src/shared/types";
import { generateAiChat } from "./ai/openaiClient";
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

const chooseAiTarget = (voterId: string, candidates: string[], round: number) => {
  const seed = [...voterId].reduce((sum, char) => sum + char.charCodeAt(0), round);
  return candidates[seed % candidates.length];
};

const revealVotes = async (env: Env, gameId: string) => {
  const game = await getGame(env.DB, gameId);

  if (!game) {
    return notFound();
  }

  const roundVotes = game.votes.filter((vote) => vote.round === game.round);

  if (roundVotes.length === 0) {
    return badRequest("No votes have been cast.");
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

  return json(await getGame(env.DB, game.id));
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

    const candidates = contestants.filter((player) => player.id !== ai.id).map((player) => player.id);
    const targetId = chooseAiTarget(ai.id, candidates, game.round);
    const target = findPlayer(game, targetId);

    await addVote(
      env.DB,
      game.id,
      game.round,
      ai.id,
      targetId,
      target ? `${target.name} looks like the cleanest way through this vote.` : "Best available target.",
      68,
    );
  }
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
        return json(await createGame(env.DB, humanName, aiCount), { status: 201 });
      }

      const gameMatch = matchRoute(url.pathname, /^\/api\/games\/(?<gameId>[^/]+)$/);
      if (request.method === "GET" && gameMatch?.gameId) {
        const game = await getGame(env.DB, gameMatch.gameId);
        return game ? json(game) : notFound();
      }

      const chatMatch = matchRoute(url.pathname, /^\/api\/games\/(?<gameId>[^/]+)\/chat\/(?<playerId>[^/]+)$/);
      if (request.method === "POST" && chatMatch?.gameId && chatMatch.playerId) {
        const game = await getGame(env.DB, chatMatch.gameId);
        if (!game) {
          return notFound();
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

        await addMessage(env.DB, game.id, game.round, "private", human.id, ai.id, humanMessage);
        const gameForPrompt = {
          ...game,
          messages: [
            ...game.messages,
            {
              id: "pending",
              gameId: game.id,
              round: game.round,
              channel: "private" as const,
              senderPlayerId: human.id,
              recipientPlayerId: ai.id,
              content: humanMessage,
              createdAt: new Date().toISOString(),
            },
          ],
        };
        const reply = await generateAiChat(env, gameForPrompt, ai, human.name, humanMessage);
        await addMessage(env.DB, game.id, game.round, "private", ai.id, human.id, reply);

        return json(await getGame(env.DB, game.id));
      }

      const tribalMatch = matchRoute(url.pathname, /^\/api\/games\/(?<gameId>[^/]+)\/advance-to-tribal$/);
      if (request.method === "POST" && tribalMatch?.gameId) {
        const game = await getGame(env.DB, tribalMatch.gameId);
        if (!game) {
          return notFound();
        }

        await updateGameStatus(env.DB, game.id, "tribal");
        await addEvent(env.DB, game.id, game.round, "tribal_started", {
          prompt: "Jeff asks the tribe where tonight's vote is really coming from.",
        });
        await addMessage(
          env.DB,
          game.id,
          game.round,
          "tribal",
          game.players.find((player) => player.kind === "host")?.id ?? null,
          null,
          "The social game is over for tonight. The vote is about trust, threat level, and who can survive one more round.",
        );

        return json(await getGame(env.DB, game.id));
      }

      const voteMatch = matchRoute(url.pathname, /^\/api\/games\/(?<gameId>[^/]+)\/vote$/);
      if (request.method === "POST" && voteMatch?.gameId) {
        const game = await getGame(env.DB, voteMatch.gameId);
        if (!game) {
          return notFound();
        }

        const body = await readJson<VoteRequest>(request);
        const target = assertActiveTarget(game, body.targetId);

        await updateGameStatus(env.DB, game.id, "voting");
        await addVote(env.DB, game.id, game.round, game.humanPlayerId, target.id, `Voted for ${target.name}.`, 100);
        await castAiVotes(env, game.id);
        await addEvent(env.DB, game.id, game.round, "votes_cast", { round: game.round });

        return json(await getGame(env.DB, game.id));
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
