-- Sliding window counter (Architecture spec 12.2). redis-coord.
-- KEYS[1] = rl:<rule>:<subject>:<currentWindowIndex>
-- KEYS[2] = rl:<rule>:<subject>:<previousWindowIndex>
-- ARGV[1] = limit, ARGV[2] = windowMs, ARGV[3] = elapsedMs in current window
local limit   = tonumber(ARGV[1])
local window  = tonumber(ARGV[2])
local elapsed = tonumber(ARGV[3])
local cur  = tonumber(redis.call('GET', KEYS[1]) or '0')
local prev = tonumber(redis.call('GET', KEYS[2]) or '0')
local weighted = prev * ((window - elapsed) / window) + cur
if weighted >= limit then
  return {0, 0, math.ceil(window - elapsed)}
end
redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], window * 2)
return {1, math.floor(limit - weighted - 1), 0}
