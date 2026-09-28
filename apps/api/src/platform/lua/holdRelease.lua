-- Releases a user's holds (Architecture spec 15.4). redis-coord.
-- KEYS[1] = bs:holds:<flightId>, KEYS[2] = bs:userholds:<userId>
-- ARGV[1] = userId, ARGV[2] = flightId, ARGV[3..] = seatIds (optional; none = all user's seats on flight)
local holdsKey, userKey = KEYS[1], KEYS[2]
local userId, flightId = ARGV[1], ARGV[2]
local seats = {}
if #ARGV > 2 then
  for i = 3, #ARGV do seats[#seats + 1] = ARGV[i] end
else
  for _, f in ipairs(redis.call('HKEYS', userKey)) do
    local fid, seat = string.match(f, '^([^:]+):(.+)$')
    if fid == flightId then seats[#seats + 1] = seat end
  end
end
local released = 0
for _, seat in ipairs(seats) do
  local v = redis.call('HGET', holdsKey, seat)
  if v and string.match(v, '^([^|]+)') == userId then
    redis.call('HDEL', holdsKey, seat)
    released = released + 1
  end
  redis.call('HDEL', userKey, flightId .. ':' .. seat)
end
return released
