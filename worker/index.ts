export interface Env {
  DB: D1Database;
  OPENAI_API_KEY: string;
  APP_ENV: string;
}

const json = (body: unknown, init: ResponseInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");

  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
};

const notFound = () => json({ error: "Not found" }, { status: 404 });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/api/health") {
      const dbCheck = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();

      return json({
        ok: true,
        appEnv: env.APP_ENV,
        database: dbCheck?.ok === 1 ? "reachable" : "unknown",
      });
    }

    if (request.method === "POST" && url.pathname === "/api/games") {
      const id = crypto.randomUUID();
      const now = new Date().toISOString();

      await env.DB.prepare(
        "INSERT INTO games (id, status, round, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      )
        .bind(id, "setup", 1, now, now)
        .run();

      return json({ id, status: "setup", round: 1 }, { status: 201 });
    }

    return notFound();
  },
} satisfies ExportedHandler<Env>;
