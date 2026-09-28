# 0005 · Token-bucket rate limiter in a Redis Lua script

- **Status:** accepted
- **Date:** 2026-09-28

## Context

Login and registration must resist password guessing and signup spam; the general API must be
protected from runaway clients. Limits have to hold across every API instance, so per-process
counters are not enough on their own.

## Options

1. **Fixed window counter** (`INCR` + `EXPIRE`). Cheap, but allows 2× the limit across a window
   boundary.
2. **Sliding window log** (a sorted set of timestamps). Exact, but memory grows with the limit.
3. **Token bucket.** A bucket holds up to `capacity` tokens and refills continuously; each request
   takes one. Allows short bursts, enforces the average rate, and stores two numbers per key.
4. **A library** such as slowapi. Less to write, but hides exactly the part worth understanding.

## Decision

A token bucket implemented as one Lua script (`app/core/ratelimit/bucket.lua`), run with
`EVALSHA`, so read, refill and take happen atomically in a single round trip with no race between
concurrent requests on different instances.

- **Time comes from the caller**, so tests drive a fake clock. Instances whose clocks run slightly
  behind the last writer get no refill rather than a negative one.
- **Keys are hashed** (`rl:<policy>:<sha256 prefix>`), so Redis holds no emails or IPs.
- **Idle keys expire** once their bucket would be full again.
- **Failure mode is per policy.** General API limits fail open onto an in-process bucket
  (availability first). Login and registration fail closed with 503 (safety first): without Redis
  there is no cross-instance limit on guessing.
- **Responses carry** `X-RateLimit-Limit`, `-Remaining`, `-Reset` (the tightest limit that
  applied), plus `Retry-After` on 429, including on failed logins, when clients need them most.
- WebSocket messages (phase 2) use the in-process bucket only: a socket lives on one instance, and
  a Redis call per keystroke would cost more than it protects.

| Policy | Limit | When Redis is down |
| --- | --- | --- |
| Login per IP | 5 / minute | closed |
| Login per email | 10 / hour | closed |
| Register per IP | 3 / hour | closed |
| Refresh per IP | 30 / minute | open |
| API per user | 120 / minute | open |

## Consequences

- One Redis round trip per limited request.
- Behaviour is tested directly: bursts, refill, shared buckets across instances, clock skew, key
  expiry, both failure modes, and the HTTP headers.
