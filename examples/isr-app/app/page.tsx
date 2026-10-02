export default function Home() {
  return (
    <main>
      <h1>CacheForge · ISR</h1>
      <p>
        <a href="/posts">/posts</a> is rendered once, cached in Redis, and served by every instance.
      </p>
    </main>
  )
}
