export const dynamic = 'force-dynamic'

export function GET() {
  return Response.json({ instance: process.env.INSTANCE_ID ?? 'local' })
}
