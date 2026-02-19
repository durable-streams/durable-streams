export interface ProxyConformanceCapabilities {
  connect?: boolean
  targetedAbort?: boolean
  framing?: boolean
}

export interface ProxyConformanceAdapter {
  createUrl?: (baseUrl: string) => URL
  streamUrl?: (baseUrl: string, streamId: string) => URL
  connectUrl?: (baseUrl: string, streamId: string) => URL
  applyServiceAuth?: (url: URL, headers: Headers) => Promise<void> | void
  normalizeLocation?: (location: string, baseUrl: string) => string
}

export interface ProxyConformanceOptions {
  baseUrl: string
  capabilities?: ProxyConformanceCapabilities
  adapter?: ProxyConformanceAdapter
  serviceSecret?: string
}

export interface ProxyConformanceRuntime {
  getBaseUrl: () => string
  capabilities: Required<ProxyConformanceCapabilities>
  adapter: Required<ProxyConformanceAdapter>
}

const DEFAULT_SERVICE_SECRET = `test-secret-key-for-development`

let runtime: ProxyConformanceRuntime | null = null

export function initRuntime(
  options: ProxyConformanceOptions
): ProxyConformanceRuntime {
  const serviceSecret = options.serviceSecret ?? DEFAULT_SERVICE_SECRET
  const adapterInput = options.adapter ?? {}

  runtime = {
    getBaseUrl: () => options.baseUrl,
    capabilities: {
      connect: options.capabilities?.connect ?? true,
      targetedAbort: options.capabilities?.targetedAbort ?? true,
      framing: options.capabilities?.framing ?? true,
    },
    adapter: {
      createUrl:
        adapterInput.createUrl ??
        ((targetBaseUrl: string) => new URL(`/v1/proxy`, targetBaseUrl)),
      streamUrl:
        adapterInput.streamUrl ??
        ((targetBaseUrl: string, streamId: string) =>
          new URL(`/v1/proxy/${encodeURIComponent(streamId)}`, targetBaseUrl)),
      connectUrl:
        adapterInput.connectUrl ??
        ((targetBaseUrl: string, streamId: string) => {
          const url = new URL(
            `/v1/proxy/${encodeURIComponent(streamId)}`,
            targetBaseUrl
          )
          url.searchParams.set(`action`, `connect`)
          return url
        }),
      applyServiceAuth:
        adapterInput.applyServiceAuth ??
        ((url: URL) => {
          url.searchParams.set(`secret`, serviceSecret)
        }),
      normalizeLocation:
        adapterInput.normalizeLocation ??
        ((location: string, targetBaseUrl: string) =>
          new URL(location, targetBaseUrl).toString()),
    },
  }

  return runtime
}

export function getRuntime(): ProxyConformanceRuntime {
  if (!runtime) {
    throw new Error(`Conformance runtime not initialized`)
  }
  return runtime
}
