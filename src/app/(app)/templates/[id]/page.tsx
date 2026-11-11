import { notFound } from "next/navigation";
import { TemplateEditor } from "@/features/templates/template-editor";

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id < 1) notFound();
  return <TemplateEditor id={id} />;
}
