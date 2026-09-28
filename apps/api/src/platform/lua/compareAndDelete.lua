-- Releases a lock only if the caller still owns it (Architecture spec 14.2). redis-coord.
-- KEYS[1] = lock key, ARGV[1] = owner token
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
