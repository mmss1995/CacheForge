import { revalidateTag } from 'next/cache'

export const dynamic = 'force-dynamic'

// POST /api/revalidate?tag=posts            soft: stale-while-revalidate
// POST /api/revalidate?tag=posts&hard=true  hard: next request waits for fresh content
export async function POST(request: Request) {
  const url = new URL(request.url)
  const tag = url.searchParams.get('tag')
  if (!tag) return Response.json({ error: 'tag is required' }, { status: 400 })
  revalidateTag(tag, url.searchParams.get('hard') === 'true' ? { expire: 0 } : 'max')
  return Response.json({ revalidated: tag, by: process.env.INSTANCE_ID ?? 'local' })
}
