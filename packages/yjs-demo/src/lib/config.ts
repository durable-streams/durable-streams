/**
 * Application configuration using Vite environment variables.
 *
 * For Netlify deployment, set VITE_SERVER_URL in the Netlify environment variables.
 * For local development, create a .env file or rely on the default fallback.
 *
 * Note: The server URL is now configurable via the ServerEndpointProvider context.
 * This export is kept for backward compatibility but should use useServerEndpoint() hook instead.
 */

function getServerUrl(): string {
  // Use environment variable if set
  if (import.meta.env.VITE_SERVER_URL) {
    return import.meta.env.VITE_SERVER_URL
  }

  // Fallback: use current hostname with default port
  const hostname =
    typeof window !== `undefined` ? window.location.hostname : `localhost`
  return `http://${hostname}:4437`
}

export const SERVER_URL = getServerUrl()
