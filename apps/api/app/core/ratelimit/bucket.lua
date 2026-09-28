-- Token bucket, evaluated atomically inside Redis so every API instance shares one bucket.
-- KEYS[1]  bucket key
-- ARGV[1]  capacity (burst size)
-- ARGV[2]  refill rate in tokens per millisecond
-- ARGV[3]  now, in Unix milliseconds, supplied by the caller so tests can control time
-- ARGV[4]  cost of this request in tokens
-- Returns { allowed (0|1), tokens left as a string, ms until one request would be allowed }

local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local cost = tonumber(ARGV[4])

local state = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(state[1]) or capacity
local ts = tonumber(state[2]) or now

-- Refill for the time elapsed. A caller whose clock runs behind the last writer's
-- (small skew between instances) simply gets no refill instead of a negative one.
if now > ts then
  tokens = math.min(capacity, tokens + (now - ts) * rate)
  ts = now
end

local allowed = 0
local retry_ms = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
else
  retry_ms = math.ceil((cost - tokens) / rate)
end

redis.call('HSET', KEYS[1], 'tokens', tokens, 'ts', ts)
-- Expire once the bucket would be full again: an idle key costs no memory.
redis.call('PEXPIRE', KEYS[1], math.ceil((capacity - tokens) / rate) + 1000)

return { allowed, tostring(tokens), retry_ms }
