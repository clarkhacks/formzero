export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_FILES_PER_SUBMISSION = 5

const ALLOWED_TYPES = [
  /^image\/(png|jpe?g|gif|webp|avif|heic|heif|bmp|tiff)$/,
  /^image\/svg\+xml$/,
  /^application\/pdf$/,
  /^text\/plain$/,
]

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.slice(start, end))

// Browsers often report an empty or odd type (HEIC, AVIF, screenshots), so trust the bytes first
function sniffType(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 4) === "PNG") return "image/png"
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  if (ascii(bytes, 0, 4) === "GIF8") return "image/gif"
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "image/webp"
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf"
  if (ascii(bytes, 0, 2) === "BM") return "image/bmp"
  if (ascii(bytes, 0, 4) === "II*\0" || ascii(bytes, 0, 4) === "MM\0*") return "image/tiff"
  if (ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12)
    if (brand === "avif" || brand === "avis") return "image/avif"
    if (/^(heic|heix|hevc|hevx|heim|heis|mif1|msf1)$/.test(brand)) return "image/heic"
  }
  return null
}

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

    const head = new Uint8Array(body instanceof Uint8Array ? body : body.slice(0, 1024)).subarray(0, 1024)
    const detected = sniffType(head)
    if (detected) {
      type = detected
    } else if (type === "image/svg+xml" || /\.svg$/i.test(name)) {
      // SVG is text, so check the content actually looks like SVG
      type = /<svg[\s>]/i.test(new TextDecoder().decode(head)) ? "image/svg+xml" : ""
    } else if (type !== "text/plain") {
      // Binary formats must match their bytes; only plain text relies on the declared type
      type = ""
    }

    if (!ALLOWED_TYPES.some(pattern => pattern.test(type))) {
      throw new UploadError(`"${field}": file type not allowed (${type || "unknown"})`, 415)
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
