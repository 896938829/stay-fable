const luaHelpers = `
local function decode(value)
  if not value then return nil end
  local ok, decoded = pcall(cjson.decode, value)
  if not ok or type(decoded) ~= "table" then return nil end
  return decoded
end

local function valid_base(record)
  return record
    and type(record.userId) == "string"
    and type(record.familyId) == "string"
    and type(record.issuedAt) == "number"
    and type(record.expiresAt) == "number"
end

local function valid_access(record)
  return valid_base(record) and record.kind == "access"
end

local function valid_refresh(record)
  return valid_base(record)
    and record.kind == "refresh"
    and type(record.accessKey) == "string"
end

local function valid_family(record)
  return valid_base(record)
    and record.kind == "family"
    and type(record.accessKey) == "string"
    and type(record.refreshKey) == "string"
end

local function valid_tombstone(record)
  return record
    and record.kind == "used-refresh"
    and type(record.userId) == "string"
    and type(record.familyId) == "string"
end
`.trim();

export const ISSUE_SESSION_SCRIPT = `
${luaHelpers}
local access = decode(ARGV[1])
local refresh = decode(ARGV[2])
local family = decode(ARGV[3])
local access_ttl = tonumber(ARGV[4])
local refresh_ttl = tonumber(ARGV[5])
local now = tonumber(ARGV[6])

if not valid_access(access)
  or not valid_refresh(refresh)
  or not valid_family(family)
  or not access_ttl or access_ttl <= 0
  or not refresh_ttl or refresh_ttl <= 0
  or not now
  or access.expiresAt <= now
  or refresh.expiresAt <= now
  or family.expiresAt <= now
  or access.userId ~= refresh.userId
  or access.userId ~= family.userId
  or access.familyId ~= refresh.familyId
  or access.familyId ~= family.familyId
  or refresh.accessKey ~= KEYS[1]
  or family.accessKey ~= KEYS[1]
  or family.refreshKey ~= KEYS[2]
  or redis.call("EXISTS", KEYS[1], KEYS[2], KEYS[3]) ~= 0 then
  return "INVALID"
end

redis.call("PSETEX", KEYS[1], access_ttl, ARGV[1])
redis.call("PSETEX", KEYS[2], refresh_ttl, ARGV[2])
redis.call("PSETEX", KEYS[3], refresh_ttl, ARGV[3])
return "OK"
`.trim();

export const INSPECT_REFRESH_SCRIPT = `
${luaHelpers}
local now = tonumber(ARGV[1])
if not now then return "INVALID" end

local raw = redis.call("GET", KEYS[1])
if not raw then
  if redis.call("EXISTS", KEYS[2]) == 1 then return "REPLAY" end
  return "INVALID"
end

local refresh = decode(raw)
if not valid_refresh(refresh) then return "INVALID" end
if refresh.expiresAt <= now then return "EXPIRED" end
return cjson.encode({ status = "ACTIVE", record = refresh })
`.trim();

export const ROTATE_SESSION_SCRIPT = `
${luaHelpers}
local now = tonumber(ARGV[1])
local new_access = decode(ARGV[2])
local new_refresh = decode(ARGV[3])
local new_family = decode(ARGV[4])
local tombstone = decode(ARGV[5])
local access_ttl = tonumber(ARGV[6])
local refresh_ttl = tonumber(ARGV[7])
if not now
  or not access_ttl or access_ttl <= 0
  or not refresh_ttl or refresh_ttl <= 0
  or not valid_access(new_access)
  or not valid_refresh(new_refresh)
  or not valid_family(new_family)
  or not valid_tombstone(tombstone)
  or new_refresh.accessKey ~= KEYS[3]
  or new_family.accessKey ~= KEYS[3]
  or new_family.refreshKey ~= KEYS[4]
  or new_access.expiresAt <= now
  or new_refresh.expiresAt <= now
  or new_family.expiresAt <= now then
  return "INVALID"
end

local old_raw = redis.call("GET", KEYS[1])
if not old_raw then
  local used = decode(redis.call("GET", KEYS[2]))
  if not valid_tombstone(used) then return "INVALID" end
  local family_key = "session:family:" .. used.familyId
  local active = decode(redis.call("GET", family_key))
  if not active then return "REPLAY" end
  if not valid_family(active)
    or active.userId ~= used.userId
    or active.familyId ~= used.familyId then
    return "INVALID"
  end
  -- Even an expiry-boundary family is removed on replay; all of its fields and
  -- expiry have been validated before this first mutation.
  if active.expiresAt <= now then
    redis.call("DEL", active.accessKey, active.refreshKey, family_key)
    return "REPLAY"
  end
  redis.call("DEL", active.accessKey, active.refreshKey, family_key)
  return "REPLAY"
end

local old_refresh = decode(old_raw)
if not valid_refresh(old_refresh) then return "INVALID" end
if old_refresh.expiresAt <= now then return "EXPIRED" end
local family_key = "session:family:" .. old_refresh.familyId
local active = decode(redis.call("GET", family_key))
if not valid_family(active)
  or active.expiresAt <= now
  or active.userId ~= old_refresh.userId
  or active.familyId ~= old_refresh.familyId
  or active.accessKey ~= old_refresh.accessKey
  or active.refreshKey ~= KEYS[1]
  or new_access.userId ~= old_refresh.userId
  or new_refresh.userId ~= old_refresh.userId
  or new_family.userId ~= old_refresh.userId
  or tombstone.userId ~= old_refresh.userId
  or new_access.familyId ~= old_refresh.familyId
  or new_refresh.familyId ~= old_refresh.familyId
  or new_family.familyId ~= old_refresh.familyId
  or tombstone.familyId ~= old_refresh.familyId
  or redis.call("EXISTS", KEYS[3], KEYS[4]) ~= 0 then
  return "INVALID"
end

redis.call("PSETEX", KEYS[3], access_ttl, ARGV[2])
redis.call("PSETEX", KEYS[4], refresh_ttl, ARGV[3])
redis.call("PSETEX", family_key, refresh_ttl, ARGV[4])
redis.call("PSETEX", KEYS[2], refresh_ttl, ARGV[5])
redis.call("DEL", old_refresh.accessKey, KEYS[1])
return "OK"
`.trim();

export const REVOKE_FAMILY_SCRIPT = `
${luaHelpers}
local now = tonumber(ARGV[1])
if not now then return "INVALID" end

local source = decode(redis.call("GET", KEYS[1]))
if source and (not valid_refresh(source) or source.expiresAt <= now) then return "INVALID" end
if not source then
  source = decode(redis.call("GET", KEYS[2]))
  if not valid_tombstone(source) then return "INVALID" end
end

local family_key = "session:family:" .. source.familyId
local active = decode(redis.call("GET", family_key))
if not active then return "REVOKED" end
if not valid_family(active)
  or active.userId ~= source.userId
  or active.familyId ~= source.familyId then
  return "INVALID"
end

redis.call("DEL", active.accessKey, active.refreshKey, family_key, KEYS[1])
return "REVOKED"
`.trim();
