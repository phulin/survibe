import type { GameView, PlayerSummary } from "@survibe/shared";

export const activeContestants = (players: PlayerSummary[]) =>
  players.filter((player) => player.kind !== "host" && player.status === "active");

export const activeAiPlayers = (players: PlayerSummary[]) =>
  players.filter((player) => player.kind === "ai" && player.status === "active");

export const findPlayer = (game: GameView, playerId: string) =>
  game.players.find((player) => player.id === playerId) ?? null;

export const assertActiveTarget = (game: GameView, targetId: string) => {
  const target = findPlayer(game, targetId);

  if (!target || target.kind === "host" || target.status !== "active") {
    throw new Error("Target must be an active player.");
  }

  return target;
};

export const shouldEndGame = (players: PlayerSummary[]) => activeContestants(players).length <= 2;

export const getPlacement = (players: PlayerSummary[]) =>
  activeContestants(players).length + 1;
