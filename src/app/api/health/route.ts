import { json, route } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export const GET = route(async () => json({ ok: true, name: "universal-mail", time: Date.now() }));
