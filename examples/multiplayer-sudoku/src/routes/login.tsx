import * as React from "react"
import { createFileRoute, Link } from "@tanstack/react-router"
import { authClient } from "@/lib/auth-client"
import { useState } from "react"

export const Route = createFileRoute(`/login`)({
  component: LoginPage,
  ssr: false,
})

function LoginPage() {
  const [email, setEmail] = useState(``)
  const [password, setPassword] = useState(``)
  const [name, setName] = useState(``)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(``)
  const [isSignUp, setIsSignUp] = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setIsLoading(true)
    setError(``)

    try {
      if (isSignUp) {
        // Sign up flow
        const { error } = await authClient.signUp.email(
          {
            email,
            password,
            name: name || email.split(`@`)[0],
          },
          {
            onSuccess: () => {
              window.location.href = `/`
            },
          }
        )

        if (error) {
          if (error.code === `USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL`) {
            setError(`Account already exists. Try signing in instead.`)
            setIsSignUp(false)
          } else {
            setError(error.message || `Sign up failed`)
          }
        }
      } else {
        // Sign in flow
        const { error } = await authClient.signIn.email(
          {
            email,
            password,
          },
          {
            onSuccess: async () => {
              await authClient.getSession()
              window.location.href = `/`
            },
          }
        )

        if (error) {
          setError(error.message || `Sign in failed`)
        }
      }
    } catch (err) {
      console.error(`Unexpected error:`, err)
      setError(`An unexpected error occurred`)
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center py-12 px-4">
      <div className="max-w-md w-full space-y-8">
        <div className="text-center">
          <Link to="/" className="inline-block">
            <h1 className="text-3xl font-bold bg-gradient-to-r from-blue-400 to-purple-500 bg-clip-text text-transparent">
              Multiplayer Sudoku
            </h1>
          </Link>
          <p className="mt-2 text-slate-400">
            {isSignUp ? `Create an account to start playing` : `Sign in to start playing`}
          </p>
        </div>

        <div className="bg-slate-800 rounded-xl p-8 shadow-xl">
          <div className="p-4 bg-blue-900/30 border border-blue-700/50 rounded-lg mb-6">
            <p className="text-sm text-blue-300">
              <strong>Quick Start:</strong> Any email/password combo will create an account or sign in.
            </p>
          </div>

          <form className="space-y-4" onSubmit={handleSubmit}>
            {isSignUp && (
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-slate-300 mb-1">
                  Display Name
                </label>
                <input
                  id="name"
                  name="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-4 py-2.5 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                  placeholder="Your name (shown on leaderboard)"
                />
              </div>
            )}

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-slate-300 mb-1">
                Email
              </label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="you@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-slate-300 mb-1">
                Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete={isSignUp ? `new-password` : `current-password`}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full px-4 py-2.5 bg-slate-700 border border-slate-600 rounded-lg text-white placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                placeholder="********"
              />
            </div>

            {error && (
              <div className="p-3 bg-red-900/30 border border-red-700/50 rounded-lg">
                <p className="text-sm text-red-400">{error}</p>
              </div>
            )}

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-3 px-4 bg-gradient-to-r from-blue-500 to-purple-600 hover:from-blue-600 hover:to-purple-700 text-white font-semibold rounded-lg transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {isLoading ? `Please wait...` : isSignUp ? `Create Account` : `Sign In`}
            </button>
          </form>

          <div className="mt-6 text-center">
            <button
              type="button"
              onClick={() => {
                setIsSignUp(!isSignUp)
                setError(``)
              }}
              className="text-sm text-blue-400 hover:text-blue-300"
            >
              {isSignUp ? `Already have an account? Sign in` : `Need an account? Sign up`}
            </button>
          </div>
        </div>

        <div className="text-center">
          <Link to="/" className="text-sm text-slate-400 hover:text-slate-300">
            Back to the game
          </Link>
        </div>
      </div>
    </div>
  )
}
