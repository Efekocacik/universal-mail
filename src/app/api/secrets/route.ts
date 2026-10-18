import { z } from "zod";
import { body, database, HttpError, json, route } from "@/lib/api/http";
import { audit } from "@/lib/db/audit";
import { deleteSecret, SECRET_NAMES, secretStatus, setSecret } from "@/lib/secrets/store";

export const dynamic = "force-dynamic";

const nameSchema = z.enum(SECRET_NAMES);

export const POST = route(async (req: Request) => {
  const db = await database();
  const { name, value } = await body(
    req,
    z.object({ name: nameSchema, value: z.string().min(8).max(300) }),
  );
  if (/\s/.test(value.trim()))
    throw new HttpError(
      400,
      "Anahtar boşluk içeremez; kopyalarken fazladan karakter gelmiş olabilir.",
    );
  await setSecret(name, value);
  await audit(db, "secret.set", "secret", name); // değer ASLA kaydedilmez
  return json({ ok: true, status: await secretStatus(name) });
});

export const DELETE = route(async (req: Request) => {
  const db = await database();
  const name = nameSchema.parse(new URL(req.url).searchParams.get("name"));
  await deleteSecret(name);
  await audit(db, "secret.deleted", "secret", name);
  return json({ ok: true, status: await secretStatus(name) });
});
