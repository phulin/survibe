import type { ChatRequest, CreateGameRequest, GameView, VoteRequest } from "../shared/types";

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => ({ error: "Request failed." }))) as { error?: string };
    throw new Error(payload.error ?? "Request failed.");
  }

  return response.json() as Promise<T>;
};

export const createGame = (body: CreateGameRequest) =>
  request<GameView>("/api/games", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const getGame = (gameId: string) => request<GameView>(`/api/games/${gameId}`);

export const sendChat = (gameId: string, aiPlayerId: string, body: ChatRequest) =>
  request<GameView>(`/api/games/${gameId}/chat/${aiPlayerId}`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const advanceToTribal = (gameId: string) =>
  request<GameView>(`/api/games/${gameId}/advance-to-tribal`, {
    method: "POST",
  });

export const castVote = (gameId: string, body: VoteRequest) =>
  request<GameView>(`/api/games/${gameId}/vote`, {
    method: "POST",
    body: JSON.stringify(body),
  });

export const revealVotes = (gameId: string) =>
  request<GameView>(`/api/games/${gameId}/reveal`, {
    method: "POST",
  });
