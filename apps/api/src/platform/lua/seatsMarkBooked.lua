-- Marks seats booked in the status hash and bumps the version (Architecture spec 14.3). redis-cache.
-- Used after every booking commit and for cache repair.
-- KEYS[1] = bs:seats:<flightId>, KEYS[2] = bs:seatsver:<flightId>
-- ARGV = seatIds
redis.call('INCR', KEYS[2])
redis.call('EXPIRE', KEYS[2], 604800)
-- If the hash doesn't exist it is not created: a partial hash would look complete.
-- The next read fills it from MySQL.
if redis.call('EXISTS', KEYS[1]) == 1 then
  for i = 1, #ARGV do redis.call('HSET', KEYS[1], ARGV[i], 'B') end
end
return 1
