-- Version-guarded seat status fill (Architecture spec 14.3). redis-cache.
-- KEYS[1] = bs:seats:<flightId>, KEYS[2] = bs:seatsver:<flightId>
-- ARGV[1] = expectedVersion, ARGV[2] = ttlSeconds, ARGV[3..] = seatId, status, seatId, status, ...
local current = redis.call('GET', KEYS[2]) or '0'
if current ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1])
-- HSET in chunks so very large aircraft cannot exceed Lua's unpack() argument limit.
local chunk = 400 -- 200 seat/status pairs
local total = #ARGV
for i = 3, total, chunk do
  local last = math.min(i + chunk - 1, total)
  redis.call('HSET', KEYS[1], unpack(ARGV, i, last))
end
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
end
return 1
