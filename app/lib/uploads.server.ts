export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_FILES_PER_SUBMISSION = 5

const ALLOWED_TYPES = [/^image\/(png|jpe?g|gif|webp|heic|heif)$/, /^application\/pdf$/, /^text\/plain$/]

export type StoredFile = {
  file: true
  id: string
  name: string
  type: string
  size: number
}

export class UploadError extends Error {
  status: number
  constructor(message: string, status = 400) {
    super(message)
    this.status = status
  }
}

export function isStoredFile(value: unknown): value is StoredFile {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as StoredFile).file === true &&
    typeof (value as StoredFile).id === "string"
  )
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100) || "file"
}

function decodeDataUrl(data: string): { bytes: Uint8Array; type: string } | null {
  const match = /^data:([^;,]+)?(?:;[^,]*)?;base64,(.*)$/s.exec(data)
  if (!match) return null
  try {
    const binary = atob(match[2])
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return { bytes, type: match[1] || "application/octet-stream" }
  } catch {
    return null
  }
}

/**
 * Replaces File values (multipart) and { name, type, data: "data:...;base64,..." }
 * objects (JSON) with StoredFile metadata after saving the bytes to R2.
 */
export async function extractUploads(
  bucket: R2Bucket | undefined,
  formId: string,
  submissionId: string,
  input: Record<string, any>
): Promise<Record<string, any>> {
  const output: Record<string, any> = {}
  const pending: { key: string; body: ArrayBuffer | Uint8Array; type: string }[] = []

  for (const [field, value] of Object.entries(input)) {
    let name: string
    let type = ""
    let body: ArrayBuffer | Uint8Array | undefined

    if (value instanceof File) {
      if (value.size === 0) continue
      name = value.name
      type = value.type
      if (value.size > MAX_FILE_BYTES) throw new UploadError(`"${field}" exceeds the 10 MB limit`, 413)
      body = await value.arrayBuffer()
    } else if (
      value && typeof value === "object" && !Array.isArray(value) &&
      typeof value.data === "string" && value.data.startsWith("data:")
    ) {
      const decoded = decodeDataUrl(value.data)
      if (!decoded) throw new UploadError(`"${field}" is not a valid file`)
      if (decoded.bytes.byteLength > MAX_FILE_BYTES) {
        throw new UploadError(`"${field}" exceeds the 10 MB limit`, 413)
      }
      name = typeof value.name === "string" ? value.name : "file"
      type = decoded.type
      body = decoded.bytes
    } else {
      output[field] = value
      continue
    }

    if (!ALLOWED_TYPES.some(pattern => pattern.test(type))) {
      throw new UploadError(`"${field}": file type not allowed`, 415)
    }
    if (!bucket) throw new UploadError("File uploads are not configured", 503)
    if (pending.length >= MAX_FILES_PER_SUBMISSION) throw new UploadError("Too many files")

    const id = `${crypto.randomUUID()}-${safeName(name)}`
    const size = body.byteLength
    pending.push({ key: `${formId}/${submissionId}/${id}`, body, type })
    output[field] = { file: true, id, name: safeName(name), type, size } satisfies StoredFile
  }

  if (pending.length > 0) {
    try {
      await Promise.all(
        pending.map(f => bucket!.put(f.key, f.body, { httpMetadata: { contentType: f.type } }))
      )
    } catch (error) {
      await deleteUploads(bucket, `${formId}/${submissionId}/`)
      throw error
    }
  }
  return output
}

export async function deleteUploads(bucket: R2Bucket | undefined, prefix: string) {
  if (!bucket) return
  try {
    let cursor: string | undefined
    do {
      const listed = await bucket.list({ prefix, cursor })
      if (listed.objects.length) await bucket.delete(listed.objects.map(o => o.key))
      cursor = listed.truncated ? listed.cursor : undefined
    } while (cursor)
  } catch (error) {
    console.error("Failed to delete uploads:", error)
  }
}
