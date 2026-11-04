import type { Route } from "./+types/api.files.$formId.$submissionId.$fileId"
import { requireAuth } from "~/lib/require-auth.server"

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { DB, UPLOADS } = context.cloudflare.env
  await requireAuth(request, DB)

  const { formId, submissionId, fileId } = params
  const object = await UPLOADS?.get(`${formId}/${submissionId}/${fileId}`)
  if (!object) return new Response("Not found", { status: 404 })

  // Only raster images may render inline (for the preview modal); everything else downloads
  const contentType = object.httpMetadata?.contentType || "application/octet-stream"
  const inline = new URL(request.url).searchParams.has("inline") && /^image\/(png|jpe?g|gif|webp)$/.test(contentType)
  const filename = fileId.slice(37).replace(/[^a-zA-Z0-9._-]/g, "_") || "file"
  return new Response(object.body, {
    headers: {
      "Content-Type": contentType,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${filename}"`,
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  })
}
