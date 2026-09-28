/**
 * WebSocket URL for an API path. Same origin by default (the Vite proxy forwards /api, WebSockets
 * included). Production sets VITE_WS_URL to the API host, because Vercel rewrites cannot proxy
 * WebSockets; the socket authenticates with a ticket, not a cookie, so cross-origin is fine.
 */
export function webSocketUrl(path: string): string {
  const base = import.meta.env.VITE_WS_URL
  if (base) return `${base.replace(/\/+$/, '')}/api${path}`
  const url = new URL(`/api${path}`, globalThis.location.origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}
