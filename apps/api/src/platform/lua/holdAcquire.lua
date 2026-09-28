-- Atomic multi-seat hold with replace semantics (Architecture spec 15.3). redis-coord, Redis 7.4+.
-- KEYS[1] = bs:holds:<flightId>
-- KEYS[2] = bs:userholds:<userId>
-- ARGV[1] = userId, ARGV[2] = flightId, ARGV[3] = ttlSeconds
-- ARGV[4] = maxSeatsPerFlight, ARGV[5] = maxFlights, ARGV[6..] = seatIds
local holdsKey, userKey = KEYS[1], KEYS[2]
local userId, flightId = ARGV[1], ARGV[2]
local ttl = tonumber(ARGV[3])
local maxSeats, maxFlights = tonumber(ARGV[4]), tonumber(ARGV[5])

local n = #ARGV - 5
if n < 1 or n > maxSeats then return {'SEAT_LIMIT'} end

local requested, conflicts, toAdd = {}, {}, {}
for i = 6, #ARGV do
  local seat = ARGV[i]
  requested[seat] = true
  local v = redis.call('HGET', holdsKey, seat)
  if v then
    if string.match(v, '^([^|]+)') ~= userId then conflicts[#conflicts + 1] = seat end
  else
    toAdd[#toAdd + 1] = seat
  end
end
if #conflicts > 0 then
  table.insert(conflicts, 1, 'CONFLICT')
  return conflicts
end

-- distinct flights the user currently holds seats on
local entries = redis.call('HKEYS', userKey)
local flights, flightCount = {}, 0
for _, f in ipairs(entries) do
  local fid = string.match(f, '^([^:]+):')
  if not flights[fid] then flights[fid] = true; flightCount = flightCount + 1 end
end
if not flights[flightId] and flightCount >= maxFlights then return {'FLIGHT_LIMIT'} end

-- replace semantics: release this user's seats on this flight that were not requested
for _, f in ipairs(entries) do
  local fid, seat = string.match(f, '^([^:]+):(.+)$')
  if fid == flightId and not requested[seat] then
    local v = redis.call('HGET', holdsKey, seat)
    if v and string.match(v, '^([^|]+)') == userId then redis.call('HDEL', holdsKey, seat) end
    redis.call('HDEL', userKey, f)
  end
end

-- use Redis server time, not app time
local t = redis.call('TIME')
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local expiresAt = nowMs + ttl * 1000

for _, seat in ipairs(toAdd) do
  redis.call('HSET', holdsKey, seat, userId .. '|' .. expiresAt)
  redis.call('HEXPIRE', holdsKey, ttl, 'FIELDS', 1, seat)
  local uf = flightId .. ':' .. seat
  redis.call('HSET', userKey, uf, expiresAt)
  redis.call('HEXPIRE', userKey, ttl, 'FIELDS', 1, uf)
end
return {'OK', tostring(#toAdd)}
