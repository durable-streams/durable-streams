import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useState } from "react"
import { generateStory } from "../server/functions"

export const Route = createFileRoute("/")({
  component: HomePage,
})

function HomePage() {
  const navigate = useNavigate()
  const [prompt, setPrompt] = useState("")
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!prompt.trim() || isLoading) return

    setIsLoading(true)
    setError(null)

    try {
      // Call the server function with prompt data
      // Type assertion needed due to TanStack Start's dynamic typing
      const serverFn = generateStory as unknown as (args: { data: { prompt: string } }) => Promise<{ streamId: string; streamUrl: string }>
      const result = await serverFn({ data: { prompt: prompt.trim() } })
      // Navigate to story page with autoplay flag
      navigate({
        to: "/story/$streamId",
        params: { streamId: result.streamId },
        search: { autoplay: "1" },
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong")
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-story-gradient flex flex-col items-center justify-center p-4 relative overflow-hidden">
      {/* Decorative elements */}
      <div className="sparkle text-4xl top-10 left-10 animate-float">✨</div>
      <div
        className="sparkle text-3xl top-20 right-20 animate-float"
        style={{ animationDelay: "0.5s" }}
      >
        ⭐
      </div>
      <div
        className="sparkle text-5xl bottom-20 left-20 animate-float"
        style={{ animationDelay: "1s" }}
      >
        🌟
      </div>
      <div
        className="sparkle text-4xl bottom-10 right-10 animate-float"
        style={{ animationDelay: "1.5s" }}
      >
        ✨
      </div>
      <div
        className="sparkle text-3xl top-1/3 left-5 animate-float"
        style={{ animationDelay: "0.3s" }}
      >
        🌙
      </div>
      <div
        className="sparkle text-4xl top-1/4 right-10 animate-float"
        style={{ animationDelay: "0.8s" }}
      >
        ☁️
      </div>

      {/* Main content */}
      <div className="relative z-10 w-full max-w-2xl">
        {/* Title */}
        <div className="text-center mb-8">
          <h1 className="text-5xl md:text-7xl font-bold text-white drop-shadow-lg mb-4 animate-bounce">
            📖 Tell Me a Story!
          </h1>
          <p className="text-xl md:text-2xl text-white/90 drop-shadow">
            What kind of adventure would you like to hear?
          </p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="relative">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="A brave little mouse who wants to become a knight..."
              className="w-full h-40 p-6 text-xl rounded-3xl border-4 border-white/30 bg-white/90 backdrop-blur-sm shadow-xl focus:outline-none focus:border-story-yellow focus:ring-4 focus:ring-story-yellow/30 resize-none placeholder-gray-400 font-story"
              maxLength={500}
              disabled={isLoading}
            />
            <div className="absolute bottom-4 right-4 text-gray-400 text-sm">
              {prompt.length}/500
            </div>
          </div>

          {error && (
            <div className="bg-red-100 border-2 border-red-300 text-red-700 px-6 py-4 rounded-2xl text-lg">
              😢 {error}
            </div>
          )}

          <button
            type="submit"
            disabled={!prompt.trim() || isLoading}
            className="w-full btn-playful disabled:opacity-50 disabled:cursor-not-allowed disabled:transform-none"
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-3">
                <span className="animate-spin text-2xl">🌀</span>
                Creating your story...
              </span>
            ) : (
              <span className="flex items-center justify-center gap-3">
                <span className="text-2xl">🪄</span>
                Create My Story!
              </span>
            )}
          </button>
        </form>

        {/* Fun suggestions */}
        <div className="mt-8 text-center">
          <p className="text-white/80 mb-3">Need ideas? Try:</p>
          <div className="flex flex-wrap justify-center gap-2">
            {[
              "A dragon who loves to bake cookies",
              "A princess who becomes a scientist",
              "A friendly robot learning to dance",
              "A magical garden where flowers sing",
            ].map((suggestion) => (
              <button
                key={suggestion}
                onClick={() => setPrompt(suggestion)}
                className="px-4 py-2 bg-white/20 hover:bg-white/30 rounded-full text-white text-sm transition-colors"
                disabled={isLoading}
              >
                {suggestion}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
