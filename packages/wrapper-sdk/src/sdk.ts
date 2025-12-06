/**
 * WrapperSDK implementation for @durable-streams/wrapper-sdk.
 */

import { DurableStream } from "@durable-streams/writer"
import { DurableStreamError, FetchError } from "@durable-streams/client"
import { StreamImpl } from "./stream"
import { WrapperSDKError } from "./errors"
import type {
  Auth,
  CreateStreamOptions,
  FilterOptions,
  HeadersRecord,
  SDKHooks,
  Storage,
  Stream,
  TrackedStreamInfo,
  WrapperSDK,
} from "./types"

/**
 * Options for creating a WrapperSDKImpl.
 */
export interface WrapperSDKImplOptions {
  /**
   * Base URL of the durable streams server.
   */
  baseUrl: string

  /**
   * State storage for tracking streams.
   */
  storage: Storage

  /**
   * Authentication configuration.
   */
  auth?: Auth

  /**
   * Additional headers for requests.
   */
  headers?: HeadersRecord

  /**
   * Custom fetch implementation.
   */
  fetch?: typeof globalThis.fetch

  /**
   * Lifecycle hooks.
   */
  hooks: SDKHooks
}

/**
 * Storage key prefix for tracking streams.
 */
const STREAMS_KEY_PREFIX = `__sdk:streams:`

/**
 * Implementation of the WrapperSDK interface.
 *
 * Provides stream CRUD operations with lifecycle hooks and state tracking.
 */
export class WrapperSDKImpl implements WrapperSDK {
  readonly #baseUrl: string
  readonly #storage: Storage
  readonly #auth?: Auth
  readonly #headers?: HeadersRecord
  readonly #fetch?: typeof globalThis.fetch
  readonly #hooks: SDKHooks

  constructor(options: WrapperSDKImplOptions) {
    // Normalize base URL by removing trailing slash
    this.#baseUrl = options.baseUrl.replace(/\/$/, ``)
    this.#storage = options.storage
    this.#auth = options.auth
    this.#headers = options.headers
    this.#fetch = options.fetch
    this.#hooks = options.hooks
  }

  /**
   * Create a new durable stream.
   *
   * @param options - Stream creation options
   * @returns The created stream handle
   */
  async createStream(options: CreateStreamOptions): Promise<Stream> {
    const fullUrl = this.#buildUrl(options.url)

    // Encode initial data if it's a string
    const body =
      typeof options.data === `string`
        ? new TextEncoder().encode(options.data)
        : options.data

    try {
      const durableStream = await DurableStream.create({
        url: fullUrl,
        contentType: options.contentType,
        ttlSeconds: options.ttlSeconds,
        expiresAt: options.expiresAt,
        body,
        auth: this.#auth,
        headers: this.#headers,
        fetch: this.#fetch,
      })

      const stream = new StreamImpl({
        id: options.url,
        durableStream,
        hooks: this.#hooks,
      })

      // Track in storage for listStreams()
      const trackingInfo: TrackedStreamInfo = {
        id: options.url,
        url: fullUrl,
        contentType: options.contentType,
        createdAt: new Date().toISOString(),
      }
      await this.#storage.set(
        `${STREAMS_KEY_PREFIX}${options.url}`,
        trackingInfo
      )

      // Call lifecycle hook
      await this.#hooks.onStreamCreated?.(stream, undefined)

      return stream
    } catch (error) {
      // Handle conflict errors (stream already exists)
      if (
        (error instanceof DurableStreamError &&
          error.code === `CONFLICT_EXISTS`) ||
        (error instanceof FetchError && error.status === 409)
      ) {
        throw WrapperSDKError.streamExists(options.url)
      }
      throw WrapperSDKError.fromError(error, `Failed to create stream`)
    }
  }

  /**
   * Get an existing stream by its URL path.
   *
   * @param id - The stream URL path
   * @returns The stream handle or null if not found
   */
  async getStream(id: string): Promise<Stream | null> {
    const fullUrl = this.#buildUrl(id)

    try {
      const durableStream = await DurableStream.connect({
        url: fullUrl,
        auth: this.#auth,
        headers: this.#headers,
        fetch: this.#fetch,
      })

      return new StreamImpl({
        id,
        durableStream,
        hooks: this.#hooks,
      })
    } catch (error) {
      // Return null if stream doesn't exist (handle both error types)
      if (
        (error instanceof DurableStreamError && error.code === `NOT_FOUND`) ||
        (error instanceof FetchError && error.status === 404)
      ) {
        return null
      }
      throw WrapperSDKError.fromError(error, `Failed to get stream`)
    }
  }

  /**
   * Delete a stream and all its data.
   *
   * @param id - The stream URL path
   * @throws WrapperSDKError if stream does not exist
   */
  async deleteStream(id: string): Promise<void> {
    const fullUrl = this.#buildUrl(id)

    // Get the stream first for the hook
    const stream = await this.getStream(id)
    if (!stream) {
      throw WrapperSDKError.streamNotFound(id)
    }

    try {
      await DurableStream.delete({
        url: fullUrl,
        auth: this.#auth,
        headers: this.#headers,
        fetch: this.#fetch,
      })

      // Remove from tracking
      await this.#storage.delete(`${STREAMS_KEY_PREFIX}${id}`)

      // Call lifecycle hook
      await this.#hooks.onStreamDeleted?.(stream)
    } catch (error) {
      // Handle not found errors
      if (
        (error instanceof DurableStreamError && error.code === `NOT_FOUND`) ||
        (error instanceof FetchError && error.status === 404)
      ) {
        throw WrapperSDKError.streamNotFound(id)
      }
      throw WrapperSDKError.fromError(error, `Failed to delete stream`)
    }
  }

  /**
   * List streams matching an optional filter.
   *
   * Note: This uses local state tracking; only streams created through
   * this SDK instance (with the same storage) will be listed.
   *
   * @param filter - Optional filter criteria
   * @yields Stream handles
   */
  async *listStreams(filter?: FilterOptions): AsyncIterable<Stream> {
    const prefix = filter?.prefix
      ? `${STREAMS_KEY_PREFIX}${filter.prefix}`
      : STREAMS_KEY_PREFIX

    for await (const [, value] of this.#storage.list(prefix)) {
      const streamInfo = value as TrackedStreamInfo
      // Attempt to get the stream (may have been deleted externally)
      const stream = await this.getStream(streamInfo.id)
      if (stream) {
        yield stream
      } else {
        // Clean up stale tracking entry
        await this.#storage.delete(`${STREAMS_KEY_PREFIX}${streamInfo.id}`)
      }
    }
  }

  /**
   * Build the full URL from a path.
   *
   * @param path - The stream URL path
   * @returns The full URL
   */
  #buildUrl(path: string): string {
    // Ensure path starts with /
    const normalizedPath = path.startsWith(`/`) ? path : `/${path}`
    return `${this.#baseUrl}${normalizedPath}`
  }
}
