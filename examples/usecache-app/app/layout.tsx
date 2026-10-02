export const metadata = { title: 'CacheForge use cache example' }

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui', maxWidth: 640, margin: '2rem auto' }}>{children}</body>
    </html>
  )
}
