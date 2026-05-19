import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) => c.text("divmemory worker"));
app.get("/health", (c) => c.json({ ok: true }));

export default app;
