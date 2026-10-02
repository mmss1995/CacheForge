import { revalidateTag } from 'next/cache'

export async function POST(request: Request) {
  const url = new URL(request.url)
  const tag = url.searchParams.get('tag')
  if (!tag) return Response.json({ error: 'tag is required' }, { status: 400 })
  revalidateTag(tag, url.searchParams.get('hard') === 'true' ? { expire: 0 } : 'max')
  return Response.json({ revalidated: tag, by: process.env.INSTANCE_ID ?? 'local' })
}
