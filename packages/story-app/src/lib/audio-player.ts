/**
 * Web Audio API-based PCM16 streaming player
 *
 * Features:
 * - Plays raw PCM16 audio (24kHz mono) as received
 * - Supports play/pause/restart controls
 * - Tracks playback position for text synchronization
 * - Handles browser autoplay restrictions
 */

const SAMPLE_RATE = 24000 // OpenAI outputs 24kHz audio
const BYTES_PER_SAMPLE = 2 // 16-bit = 2 bytes

type PlayerState = "idle" | "playing" | "paused"

export interface AudioPlayerState {
  isPlaying: boolean
  isPaused: boolean
  isBlocked: boolean // Autoplay blocked by browser
  currentTime: number // Current playback position in seconds
  duration: number // Total buffered duration in seconds
  isFinished: boolean
}

export type AudioPlayerCallback = (state: AudioPlayerState) => void

export class AudioPlayer {
  private audioContext: AudioContext | null = null
  private allChunks: Float32Array[] = [] // All received chunks (for restart)
  private scheduledSources: AudioBufferSourceNode[] = []
  private totalBufferedSamples: number = 0
  
  // Playback state
  private state: PlayerState = "idle"
  private isBlocked: boolean = false
  private streamFinished: boolean = false // Stream has finished loading
  private playbackCompleted: boolean = false // User has played through to the end
  
  // Timing
  private playbackStartTime: number = 0 // AudioContext time when playback started
  private playbackStartOffset: number = 0 // Position in audio when playback started
  private pausedAt: number = 0 // Audio position when paused
  private lastScheduledEndTime: number = 0 // When the last scheduled chunk ends
  private nextChunkIndex: number = 0 // Next chunk to schedule
  
  private onStateChange: AudioPlayerCallback | null = null
  private updateInterval: number | null = null

  constructor() {
    // AudioContext will be created on first play attempt
  }

  setOnStateChange(callback: AudioPlayerCallback): void {
    this.onStateChange = callback
  }

  getState(): AudioPlayerState {
    return {
      isPlaying: this.state === "playing",
      isPaused: this.state === "paused",
      isBlocked: this.isBlocked,
      currentTime: this.getCurrentTime(),
      duration: this.getDuration(),
      isFinished: this.playbackCompleted, // Only true when user has played through to the end
    }
  }

  private notifyStateChange(): void {
    if (this.onStateChange) {
      this.onStateChange(this.getState())
    }
  }

  private async initContext(): Promise<boolean> {
    if (!this.audioContext) {
      this.audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })
    }

    if (this.audioContext.state === "suspended") {
      try {
        await this.audioContext.resume()
        // Small delay to let the browser settle the state
        await new Promise(resolve => setTimeout(resolve, 10))
      } catch {
        this.isBlocked = true
        this.notifyStateChange()
        return false
      }
    }

    // Check state after resume attempt
    this.isBlocked = this.audioContext.state === "suspended"
    
    if (this.isBlocked) {
      this.notifyStateChange()
      return false
    }
    
    this.startUpdateLoop()
    return true
  }

  private startUpdateLoop(): void {
    if (this.updateInterval !== null) return

    this.updateInterval = window.setInterval(() => {
      if (this.state === "playing") {
        // Check if playback finished
        const currentTime = this.getCurrentTime()
        const duration = this.getDuration()
        if (this.streamFinished && duration > 0 && currentTime >= duration - 0.05) {
          this.state = "idle"
          this.pausedAt = 0
          this.playbackCompleted = true // Mark that we've played through to the end
        }
        this.notifyStateChange()
      }
    }, 50)
  }

  private stopUpdateLoop(): void {
    if (this.updateInterval !== null) {
      clearInterval(this.updateInterval)
      this.updateInterval = null
    }
  }

  /**
   * Add PCM16 audio data
   */
  addAudioData(pcm16Data: Uint8Array): void {
    if (pcm16Data.length === 0) return

    // Convert PCM16 to Float32
    const samples = pcm16Data.length / BYTES_PER_SAMPLE
    const float32Data = new Float32Array(samples)

    for (let i = 0; i < samples; i++) {
      const low = pcm16Data[i * 2]
      const high = pcm16Data[i * 2 + 1]
      const sample = (high << 8) | low
      float32Data[i] = sample >= 0x8000 ? (sample - 0x10000) / 32768 : sample / 32768
    }

    this.allChunks.push(float32Data)
    this.totalBufferedSamples += samples

    // If playing, schedule the new chunk
    if (this.state === "playing" && this.audioContext) {
      this.scheduleChunk(this.allChunks.length - 1)
    }

    this.notifyStateChange()
  }

  markFinished(): void {
    this.streamFinished = true
    this.notifyStateChange()
  }

  /**
   * Start or resume playback
   */
  async play(): Promise<boolean> {
    const contextReady = await this.initContext()
    if (!contextReady) return false

    if (this.state === "paused") {
      // Resume from paused position
      this.resumeFromPosition(this.pausedAt)
    } else if (this.state === "idle") {
      // Start from beginning (or from pausedAt if set)
      this.resumeFromPosition(this.pausedAt)
    }

    this.state = "playing"
    this.notifyStateChange()
    return true
  }

  /**
   * Pause playback
   */
  pause(): void {
    if (this.state !== "playing") return

    // Save current position
    this.pausedAt = this.getCurrentTime()
    this.state = "paused"

    // Stop all scheduled sources
    this.stopAllSources()
    this.notifyStateChange()
  }

  /**
   * Restart from the beginning
   */
  async restart(): Promise<boolean> {
    this.stopAllSources()
    this.state = "idle"
    this.pausedAt = 0
    this.nextChunkIndex = 0
    this.playbackCompleted = false
    
    return this.play()
  }

  /**
   * Seek to a specific position (in seconds)
   * Used for resuming from saved progress
   */
  seekTo(positionSeconds: number): void {
    const wasPlaying = this.state === "playing"
    
    if (wasPlaying) {
      this.stopAllSources()
    }
    
    this.pausedAt = Math.min(positionSeconds, this.getDuration())
    
    if (wasPlaying) {
      this.resumeFromPosition(this.pausedAt)
    }
    
    this.notifyStateChange()
  }

  /**
   * Stop playback completely
   */
  stop(): void {
    this.stopAllSources()
    this.state = "idle"
    this.pausedAt = 0
    this.nextChunkIndex = 0
    this.playbackCompleted = false
    this.notifyStateChange()
  }

  destroy(): void {
    this.stop()
    this.stopUpdateLoop()
    if (this.audioContext) {
      this.audioContext.close()
      this.audioContext = null
    }
  }

  getCurrentTime(): number {
    if (this.state === "paused" || this.state === "idle") {
      return this.pausedAt
    }

    if (!this.audioContext) return 0

    const elapsed = this.audioContext.currentTime - this.playbackStartTime
    return Math.min(this.playbackStartOffset + elapsed, this.getDuration())
  }

  getDuration(): number {
    return this.totalBufferedSamples / SAMPLE_RATE
  }

  isAutoplayBlocked(): boolean {
    return this.isBlocked
  }

  /**
   * Check if the stream has finished loading (all audio received)
   */
  isStreamComplete(): boolean {
    return this.streamFinished
  }

  private resumeFromPosition(positionSeconds: number): void {
    if (!this.audioContext) return

    this.stopAllSources()
    
    this.playbackStartTime = this.audioContext.currentTime
    this.playbackStartOffset = positionSeconds
    this.lastScheduledEndTime = this.audioContext.currentTime

    // Find the chunk that contains this position and schedule from there
    let accumulatedTime = 0
    this.nextChunkIndex = 0

    for (let i = 0; i < this.allChunks.length; i++) {
      const chunkDuration = this.allChunks[i].length / SAMPLE_RATE
      const chunkEndTime = accumulatedTime + chunkDuration

      if (chunkEndTime <= positionSeconds) {
        // This chunk is before our position, skip it
        accumulatedTime = chunkEndTime
        this.nextChunkIndex = i + 1
        continue
      }

      // This chunk contains or is after our position
      if (accumulatedTime < positionSeconds) {
        // We need to start partway through this chunk
        const skipSeconds = positionSeconds - accumulatedTime
        const skipSamples = Math.floor(skipSeconds * SAMPLE_RATE)
        const partialChunk = this.allChunks[i].slice(skipSamples)
        
        if (partialChunk.length > 0) {
          this.scheduleFloat32Data(partialChunk)
        }
        this.nextChunkIndex = i + 1
      } else {
        // Schedule this whole chunk
        this.scheduleChunk(i)
        this.nextChunkIndex = i + 1
      }
      
      accumulatedTime = chunkEndTime
    }

    // Schedule remaining chunks
    while (this.nextChunkIndex < this.allChunks.length) {
      this.scheduleChunk(this.nextChunkIndex)
      this.nextChunkIndex++
    }
  }

  private scheduleChunk(index: number): void {
    if (index >= this.allChunks.length) return
    this.scheduleFloat32Data(this.allChunks[index])
  }

  private scheduleFloat32Data(float32Data: Float32Array): void {
    if (!this.audioContext || float32Data.length === 0) return

    const buffer = this.audioContext.createBuffer(1, float32Data.length, SAMPLE_RATE)
    buffer.copyToChannel(float32Data, 0)

    const source = this.audioContext.createBufferSource()
    source.buffer = buffer
    source.connect(this.audioContext.destination)

    const startTime = Math.max(this.lastScheduledEndTime, this.audioContext.currentTime)
    source.start(startTime)
    this.lastScheduledEndTime = startTime + buffer.duration

    this.scheduledSources.push(source)

    source.onended = () => {
      const idx = this.scheduledSources.indexOf(source)
      if (idx > -1) this.scheduledSources.splice(idx, 1)
    }
  }

  private stopAllSources(): void {
    for (const source of this.scheduledSources) {
      try {
        source.stop()
      } catch {
        // Ignore
      }
    }
    this.scheduledSources = []
  }
}

// Singleton
let playerInstance: AudioPlayer | null = null

export function getAudioPlayer(): AudioPlayer {
  if (!playerInstance) {
    playerInstance = new AudioPlayer()
  }
  return playerInstance
}

export function resetAudioPlayer(): void {
  if (playerInstance) {
    playerInstance.destroy()
    playerInstance = null
  }
}
