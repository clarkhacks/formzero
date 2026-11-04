import type { Route } from "./+types/api.files.$formId.$submissionId.$fileId"
import { requireAuth } from "~/lib/require-auth.server"

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { DB, UPLOADS } = context.cloudflare.env
  await requireAuth(request, DB)

  const { formId, submissionId, fileId } = params
  const object = await UPLOADS?.get(`${formId}/${submissionId}/${fileId}`)
  if (!object) return new Response("Not found", { status: 404 })

  // Always download (never render) user-supplied content on the admin origin
  const filename = fileId.slice(37).replace(/[^a-zA-Z0-9._-]/g, "_") || "file"
  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  })
}
