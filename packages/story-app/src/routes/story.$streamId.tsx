import { createFileRoute, Link, useSearch } from "@tanstack/react-router"
import { useCallback, useEffect, useRef, useState } from "react"
import { stream } from "@durable-streams/client"
import {
  parseFrames,
  concatBytes,
  FrameType,
  type Frame,
} from "../lib/frame-parser"
import { AudioPlayer, type AudioPlayerState } from "../lib/audio-player"
import {
  saveStoryProgress,
  loadStoryProgress,
  clearStoryProgress,
  type StoryProgress,
} from "../lib/storage"

// Environment - will be replaced by build
const DURABLE_STREAM_URL = "http://localhost:4437"

// Sample rate for calculating audio timing
const SAMPLE_RATE = 24000
const BYTES_PER_SAMPLE = 2

type PageState =
  | "loading"
  | "blocked"
  | "playing"
  | "paused"
  | "finished"
  | "error"
  | "not-found"

interface SearchParams {
  autoplay?: string
}

// A segment pairs text with audio timing
interface TextSegment {
  text: string
  isTitle: boolean
  audioStartTime: number // When this text's audio starts (in seconds)
}

export const Route = createFileRoute("/story/$streamId")({
  component: StoryPage,
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    autoplay: search.autoplay as string | undefined,
  }),
})

function StoryPage() {
  const { streamId } = Route.useParams()
  const search = useSearch({ from: "/story/$streamId" })
  const autoplay = search.autoplay === "1"

  // State
  const [pageState, setPageState] = useState<PageState>("loading")
  const [title, setTitle] = useState<string | null>(null)
  const [prompt, setPrompt] = useState<string | null>(null)
  const [textSegments, setTextSegments] = useState<TextSegment[]>([])
  const [visibleTextIndex, setVisibleTextIndex] = useState(-1)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [audioState, setAudioState] = useState<AudioPlayerState>({
    isPlaying: false,
    isPaused: false,
    isBlocked: false,
    currentTime: 0,
    duration: 0,
    isFinished: false,
  })
  const [copied, setCopied] = useState(false)

  // Refs
  const audioPlayerRef = useRef<AudioPlayer | null>(null)
  const streamBufferRef = useRef<Uint8Array>(new Uint8Array(0))
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const hasStartedRef = useRef(false)
  const currentOffsetRef = useRef<string>("-1")
  const userScrolledRef = useRef(false)
  
  // Track audio timing for text sync
  const audioTimeAccumulatorRef = useRef(0)
  const pendingTextRef = useRef<string | null>(null)
  const allSegmentsRef = useRef<TextSegment[]>([])

  // Update page title when story title changes
  useEffect(() => {
    if (title) {
      document.title = `${title} - Tell Me a Story!`
    }
    return () => {
      document.title = "Tell Me a Story!"
    }
  }, [title])

  // Initialize audio player
  useEffect(() => {
    audioPlayerRef.current = new AudioPlayer()
    audioPlayerRef.current.setOnStateChange(setAudioState)

    return () => {
      if (audioPlayerRef.current) {
        audioPlayerRef.current.destroy()
      }
    }
  }, [])

  // Update visible text based on audio playback time
  useEffect(() => {
    if (!audioState.isPlaying || audioState.isPaused) return
    
    const currentTime = audioState.currentTime
    let newVisibleIndex = -1
    
    for (let i = 0; i < allSegmentsRef.current.length; i++) {
      if (allSegmentsRef.current[i].audioStartTime <= currentTime) {
        newVisibleIndex = i
      } else {
        break
      }
    }
    
    if (newVisibleIndex !== visibleTextIndex) {
      setVisibleTextIndex(newVisibleIndex)
    }
  }, [audioState.currentTime, audioState.isPlaying, audioState.isPaused, visibleTextIndex])

  // Auto-scroll window to bottom when new text appears (unless user scrolled up)
  useEffect(() => {
    if (userScrolledRef.current) return
    
    // Scroll window to bottom
    window.scrollTo({
      top: document.documentElement.scrollHeight,
      behavior: "smooth",
    })
  }, [visibleTextIndex])

  // Detect user scroll - check if they scrolled away from bottom
  useEffect(() => {
    const handleScroll = () => {
      const distanceFromBottom = 
        document.documentElement.scrollHeight - 
        window.scrollY - 
        window.innerHeight
      
      // If user is near bottom (within 150px), enable auto-scroll
      if (distanceFromBottom < 150) {
        userScrolledRef.current = false
      } else {
        // User scrolled up, disable auto-scroll
        userScrolledRef.current = true
      }
    }

    window.addEventListener("scroll", handleScroll, { passive: true })
    return () => window.removeEventListener("scroll", handleScroll)
  }, [])

  // Process received frames
  const processFrames = useCallback((frames: Frame[]) => {
    for (const frame of frames) {
      switch (frame.type) {
        case FrameType.METADATA:
          setPrompt(frame.payload.prompt)
          break

        case FrameType.TEXT:
          if (frame.payload.isTitle) {
            setTitle(frame.payload.text)
          } else {
            // Store pending text to be paired with next audio
            pendingTextRef.current = (pendingTextRef.current || "") + frame.payload.text
          }
          break

        case FrameType.AUDIO:
          if (audioPlayerRef.current) {
            audioPlayerRef.current.addAudioData(frame.payload)
            
            // Calculate audio duration for this chunk
            const samples = frame.payload.length / BYTES_PER_SAMPLE
            const chunkDuration = samples / SAMPLE_RATE
            
            // If we have pending text, pair it with this audio timing
            if (pendingTextRef.current) {
              const segment: TextSegment = {
                text: pendingTextRef.current,
                isTitle: false,
                audioStartTime: audioTimeAccumulatorRef.current,
              }
              allSegmentsRef.current.push(segment)
              setTextSegments([...allSegmentsRef.current])
              pendingTextRef.current = null
            }
            
            audioTimeAccumulatorRef.current += chunkDuration
          }
          break

        case FrameType.END:
          // Flush any remaining pending text
          if (pendingTextRef.current) {
            const segment: TextSegment = {
              text: pendingTextRef.current,
              isTitle: false,
              audioStartTime: audioTimeAccumulatorRef.current,
            }
            allSegmentsRef.current.push(segment)
            setTextSegments([...allSegmentsRef.current])
            pendingTextRef.current = null
          }
          
          if (audioPlayerRef.current) {
            audioPlayerRef.current.markFinished()
          }
          break

        case FrameType.ERROR:
          setErrorMessage(frame.payload.error)
          setPageState("error")
          break
      }
    }
  }, [])

  // Save progress periodically
  const saveProgress = useCallback(() => {
    const visibleText = allSegmentsRef.current
      .slice(0, visibleTextIndex + 1)
      .map(s => s.text)
      .join("")
    
    const progress: StoryProgress = {
      offset: currentOffsetRef.current,
      textContent: visibleText,
      title,
      prompt,
      finished: pageState === "finished",
    }
    saveStoryProgress(streamId, progress)
  }, [streamId, visibleTextIndex, title, prompt, pageState])

  // Subscribe to stream
  const subscribeToStream = useCallback(
    async (startOffset: string = "-1") => {
      const streamUrl = `${DURABLE_STREAM_URL}/v1/stream/${streamId}`

      try {
        const res = await stream({
          url: streamUrl,
          offset: startOffset,
          live: "long-poll",
        })

        // Subscribe to byte chunks
        const unsubscribe = res.subscribeBytes(async (chunk) => {
          // Update current offset
          currentOffsetRef.current = chunk.offset

          // Append to buffer and parse frames
          streamBufferRef.current = concatBytes(
            streamBufferRef.current,
            chunk.data
          )
          const { frames, remainder } = parseFrames(streamBufferRef.current)
          streamBufferRef.current = remainder

          // Process frames
          processFrames(frames)

          // Save progress
          saveProgress()
        })

        unsubscribeRef.current = unsubscribe
      } catch (err) {
        console.error("Stream subscription error:", err)
        if (
          err instanceof Error &&
          (err.message.includes("404") || err.message.includes("Not Found"))
        ) {
          setPageState("not-found")
        } else {
          setErrorMessage(
            err instanceof Error ? err.message : "Failed to load story"
          )
          setPageState("error")
        }
      }
    },
    [streamId, processFrames, saveProgress]
  )

  // Initial load and stream subscription
  useEffect(() => {
    if (hasStartedRef.current) return
    hasStartedRef.current = true

    // Check for saved progress
    const savedProgress = loadStoryProgress(streamId)
    if (savedProgress) {
      // Restore saved state
      setTitle(savedProgress.title)
      setPrompt(savedProgress.prompt)
      currentOffsetRef.current = savedProgress.offset

      if (savedProgress.finished) {
        setPageState("finished")
      } else {
        setPageState("paused")
      }

      // Resume from saved offset
      subscribeToStream(savedProgress.offset)
    } else {
      // Start fresh
      subscribeToStream("-1")
    }

    return () => {
      if (unsubscribeRef.current) {
        unsubscribeRef.current()
      }
    }
  }, [streamId, subscribeToStream])

  // Auto-start playback when we have audio and autoplay is enabled
  useEffect(() => {
    if (
      autoplay &&
      pageState === "loading" &&
      audioState.duration > 0 &&
      audioPlayerRef.current
    ) {
      handlePlay()
    }
  }, [autoplay, pageState, audioState.duration])

  // Update page state based on audio state
  useEffect(() => {
    if (audioState.isBlocked) {
      setPageState("blocked")
    } else if (audioState.isPlaying && !audioState.isPaused) {
      setPageState("playing")
    } else if (audioState.isPaused) {
      setPageState("paused")
    } else if (audioState.isFinished && !audioState.isPlaying) {
      setPageState("finished")
      // Show all text when finished
      setVisibleTextIndex(allSegmentsRef.current.length - 1)
    }
  }, [audioState])

  // Handlers
  const handlePlay = async () => {
    if (audioPlayerRef.current) {
      const success = await audioPlayerRef.current.play()
      if (!success) {
        setPageState("blocked")
      }
    }
  }

  const handlePause = () => {
    if (audioPlayerRef.current) {
      audioPlayerRef.current.pause()
    }
  }

  const handleRestart = async () => {
    clearStoryProgress(streamId)
    
    // Reset text display
    setVisibleTextIndex(-1)
    userScrolledRef.current = false
    
    if (audioPlayerRef.current) {
      await audioPlayerRef.current.restart()
    }
  }

  const handleShare = async () => {
    const url = window.location.href.split("?")[0] // Remove autoplay param
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      window.prompt("Copy this link to share:", url)
    }
  }

  // Build visible text content
  const visibleText = textSegments
    .slice(0, visibleTextIndex + 1)
    .map(s => s.text)
    .join("")

  // Render loading state
  if (pageState === "loading" && !title && textSegments.length === 0) {
    return (
      <div className="min-h-screen bg-story-gradient flex items-center justify-center">
        <div className="text-center text-white">
          <div className="text-6xl mb-4 animate-bounce">📖</div>
          <p className="text-2xl animate-pulse">Loading your story...</p>
        </div>
      </div>
    )
  }

  // Render not found state
  if (pageState === "not-found") {
    return (
      <div className="min-h-screen bg-story-gradient flex items-center justify-center p-4">
        <div className="book-container max-w-lg text-center">
          <div className="text-6xl mb-4">📭</div>
          <h1 className="text-3xl font-bold text-gray-800 mb-4">
            Story Not Found
          </h1>
          <p className="text-gray-600 mb-6">
            This story may have expired or never existed.
          </p>
          <Link to="/" className="btn-playful inline-block">
            Create a New Story
          </Link>
        </div>
      </div>
    )
  }

  // Render error state
  if (pageState === "error") {
    return (
      <div className="min-h-screen bg-story-gradient flex items-center justify-center p-4">
        <div className="book-container max-w-lg text-center">
          <div className="text-6xl mb-4">😢</div>
          <h1 className="text-3xl font-bold text-gray-800 mb-4">
            Oops! Something went wrong
          </h1>
          <p className="text-gray-600 mb-6">{errorMessage}</p>
          <Link to="/" className="btn-playful inline-block">
            Try Again
          </Link>
        </div>
      </div>
    )
  }

  // Calculate progress percentage
  const progress =
    audioState.duration > 0
      ? (audioState.currentTime / audioState.duration) * 100
      : 0

  return (
    <div className="min-h-screen bg-story-gradient">
      {/* Decorative elements */}
      <div className="sparkle text-3xl top-5 left-5 animate-float">✨</div>
      <div
        className="sparkle text-2xl top-10 right-10 animate-float"
        style={{ animationDelay: "0.5s" }}
      >
        ⭐
      </div>

      {/* Main content area */}
      <div className="flex flex-col items-center p-4 pb-32">
        {/* Book container */}
        <div className="book-container w-full max-w-3xl relative">
          {/* Autoplay blocked overlay */}
          {pageState === "blocked" && (
            <div className="absolute inset-0 bg-black/50 rounded-3xl flex items-center justify-center z-20">
              <button
                onClick={handlePlay}
                className="btn-playful text-2xl flex items-center gap-3"
              >
                <span className="text-4xl">▶️</span>
                Tap to Listen
              </button>
            </div>
          )}

          {/* Title */}
          {title && (
            <h1 className="text-3xl md:text-4xl font-bold text-center text-story-purple mb-6 flex-shrink-0">
              {title}
            </h1>
          )}

          {/* Story text */}
          <div className="prose prose-lg max-w-none mb-8">
            <p className="text-xl md:text-2xl leading-relaxed text-gray-800 whitespace-pre-wrap">
              {visibleText || (
                <span className="text-gray-400 italic">
                  {pageState === "paused" ? "Press play to start..." : "Story is loading..."}
                </span>
              )}
            </p>
          </div>

          {/* Finished overlay */}
          {pageState === "finished" && (
            <div className="text-center py-8 border-t-2 border-story-yellow/30 flex-shrink-0">
              <p className="text-3xl font-bold text-story-purple mb-4">
                ✨ The End ✨
              </p>
              <div className="flex flex-wrap justify-center gap-4">
                <button onClick={handleRestart} className="btn-playful text-lg">
                  🔄 Listen Again
                </button>
                <Link
                  to="/"
                  className="btn-playful text-lg bg-gradient-to-r from-story-green to-story-blue"
                >
                  ➕ Create New Story
                </Link>
              </div>
            </div>
          )}

          {/* Progress bar */}
          <div className="mt-6 mb-4 flex-shrink-0">
            <div className="h-3 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-story-purple to-story-pink transition-all duration-300"
                style={{ width: `${progress}%` }}
              />
            </div>
            <div className="flex justify-between text-sm text-gray-500 mt-1">
              <span>{formatTime(audioState.currentTime)}</span>
              <span>{formatTime(audioState.duration)}</span>
            </div>
          </div>

          {/* Prompt footer */}
          {prompt && (
            <div className="text-center text-sm text-gray-400 border-t border-gray-200 pt-4 flex-shrink-0">
              Inspired by: &quot;{prompt}&quot;
            </div>
          )}
        </div>
      </div>

      {/* Controls - fixed at bottom */}
      <div className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur-sm shadow-lg py-4 px-6">
        <div className="max-w-3xl mx-auto flex items-center justify-center gap-4">
          {/* Home button */}
          <Link
            to="/"
            className="btn-control text-2xl hover:bg-gray-100"
            title="New Story"
          >
            🏠
          </Link>

          {/* Restart button */}
          <button
            onClick={handleRestart}
            className="btn-control text-2xl hover:bg-gray-100"
            title="Restart"
          >
            ⏮️
          </button>

          {/* Play/Pause button */}
          <button
            onClick={pageState === "playing" ? handlePause : handlePlay}
            className="btn-control w-20 h-20 text-4xl bg-gradient-to-r from-story-purple to-story-pink text-white"
            title={pageState === "playing" ? "Pause" : "Play"}
          >
            {pageState === "playing" ? "⏸️" : "▶️"}
          </button>

          {/* Share button */}
          <button
            onClick={handleShare}
            className="btn-control text-2xl hover:bg-gray-100 relative"
            title="Share"
          >
            📤
            {copied && (
              <span className="absolute -top-10 left-1/2 -translate-x-1/2 bg-black text-white text-sm px-3 py-1 rounded-full whitespace-nowrap">
                Link copied!
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * Format seconds to MM:SS
 */
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${mins}:${secs.toString().padStart(2, "0")}`
}
