import { initials } from './colors'
import type { Peer } from './CollabProvider'

const MAX_SHOWN = 5

export function PresenceAvatars({ peers }: { peers: Peer[] }) {
  // Several tabs of one person share a name; show each person once, yourself last.
  const people = [...new Map(peers.map((peer) => [peer.name, peer])).values()].sort(
    (a, b) => Number(a.self) - Number(b.self),
  )
  const shown = people.slice(0, MAX_SHOWN)
  const hidden = people.length - shown.length

  return (
    <ul aria-label="People here now" className="flex -space-x-2">
      {shown.map((peer) => (
        <li
          key={peer.clientId}
          title={peer.self ? `${peer.name} (you)` : peer.name}
          style={{ backgroundColor: peer.color }}
          className="flex size-8 items-center justify-center rounded-full text-xs font-semibold text-white ring-2 ring-white dark:ring-slate-900"
        >
          <span aria-hidden="true">{initials(peer.name)}</span>
          <span className="sr-only">{peer.self ? `${peer.name} (you)` : peer.name}</span>
        </li>
      ))}
      {hidden > 0 && (
        <li className="flex size-8 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-700 ring-2 ring-white dark:bg-slate-700 dark:text-slate-100 dark:ring-slate-900">
          +{hidden}
        </li>
      )}
    </ul>
  )
}
