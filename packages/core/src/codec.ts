/**
 * Next's incremental cache values hold `Buffer`s and `Map`s, which JSON cannot carry. The codec
 * wraps them in tagged objects so a value written by one instance reads back identical on another.
 */
const BUFFER = '__cf_buffer'
const MAP = '__cf_map'

type Encoded = { [BUFFER]: string } | { [MAP]: [string, unknown][] }

function replacer(this: unknown, key: string, value: unknown): unknown {
  // JSON.stringify calls toJSON before the replacer, so a Buffer arrives as {type, data}.
  const raw = (this as Record<string, unknown>)[key]
  if (Buffer.isBuffer(raw)) return { [BUFFER]: raw.toString('base64') } satisfies Encoded
  if (raw instanceof Uint8Array) {
    return { [BUFFER]: Buffer.from(raw).toString('base64') } satisfies Encoded
  }
  if (raw instanceof Map) return { [MAP]: [...raw.entries()] } satisfies Encoded
  return value
}

function reviver(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object') {
    if (BUFFER in value) return Buffer.from((value as { [BUFFER]: string })[BUFFER], 'base64')
    if (MAP in value) return new Map((value as { [MAP]: [string, unknown][] })[MAP])
  }
  return value
}

export function encodeValue(value: unknown): string {
  return JSON.stringify(value, replacer)
}

export function decodeValue<T = unknown>(data: string): T {
  return JSON.parse(data, reviver) as T
}

export function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64')
}

export function base64ToBytes(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, 'base64'))
}

/** Drain a stream into one buffer. */
export async function readStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    chunks.push(chunk.value)
    length += chunk.value.byteLength
  }
  const out = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export function streamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes)
      controller.close()
    },
  })
}
