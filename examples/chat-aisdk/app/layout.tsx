import type { Metadata } from "next"
import "./globals.css"

export const metadata: Metadata = {
  title: `Chat — Next.js + Vercel AI SDK`,
  description: `A basic chat app built with the Vercel AI SDK`,
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 antialiased">{children}</body>
    </html>
  )
}
