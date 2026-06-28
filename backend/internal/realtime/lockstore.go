// Cross-instance collaborative-lock authority (doc 16 FR-8, roadmap section 8).
// The per-room in-memory lockTable is instance-local and cannot stop two gateway
// instances from granting the same node. A LockStore is the shared compare-and-
// swap authority: acquisition is atomic across instances, and a holder's locks
// auto-expire (TTL) if its instance crashes, so nothing stays stuck. It is
// OPTIONAL: with no store (the default), the hub uses the in-memory lockTable
// exactly as before (single instance / self-host). The Redis implementation
// reuses the same deployment as the fan-out coordinator (REDIS_URL).
package realtime

import (
	"context"
	"encoding/json"
	"time"

	"github.com/redis/go-redis/v9"
)

// LockStore is the cross-instance lock authority. All methods are design-scoped.
// Implementations must be safe for concurrent use and must never be called while
// the hub mutex is held (they do network I/O).
type LockStore interface {
	// Acquire atomically claims each node for `holder` with the given TTL. A node
	// free or already held by this holder is granted (and its TTL refreshed); a
	// node held by another is denied. Returns the granted node ids and a map of
	// nodeId -> current holder for the denied ones.
	Acquire(ctx context.Context, designID string, nodeIDs []string, holder LockHolder, ttl time.Duration) (granted []string, denied LockMap, err error)
	// Release removes each node iff still held by clientID (compare-and-delete, so
	// a lock that expired and was re-taken by another is never wrongly released).
	Release(ctx context.Context, designID, clientID string, nodeIDs []string) error
	// ReleaseAll removes every node held by clientID in the design (on leave/sweep).
	ReleaseAll(ctx context.Context, designID, clientID string) error
	// Refresh extends the TTL on every node held by clientID (heartbeat liveness).
	Refresh(ctx context.Context, designID, clientID string, ttl time.Duration) error
	// Snapshot returns the full authoritative lock map for the design, self-healing
	// the index by dropping any node whose key has expired.
	Snapshot(ctx context.Context, designID string) (LockMap, error)
	Close() error
}

// --- Redis implementation -------------------------------------------------

// lockKey is the per-node authority key; lockSetKey indexes a design's locked
// nodes so the map can be enumerated (snapshot / release-all) without SCAN.
func lockKey(designID, nodeID string) string { return "hc:rt:lk:{" + designID + "}:" + nodeID }
func lockSetKey(designID string) string      { return "hc:rt:lks:{" + designID + "}" }

// compare-and-delete: drop the lock key + index entry only if WE still hold it.
// KEYS[1]=lock key, KEYS[2]=index set; ARGV[1]=clientID, ARGV[2]=nodeID.
var lockDelScript = redis.NewScript(`
local v = redis.call('GET', KEYS[1])
if v == false then
  redis.call('SREM', KEYS[2], ARGV[2])
  return 0
end
local ok, h = pcall(cjson.decode, v)
if ok and h.clientId == ARGV[1] then
  redis.call('DEL', KEYS[1])
  redis.call('SREM', KEYS[2], ARGV[2])
  return 1
end
return 0
`)

// atomic acquire: grant the node iff free or already ours, refresh its TTL, and
// add it to the index (all in one step so there is no SETNX->SADD gap and no
// re-lock SET that could clobber a holder taken in a TOCTOU window). The index
// set is given its own TTL so an abandoned design's index self-collects.
// KEYS[1]=lock key, KEYS[2]=index set;
// ARGV: 1=holderJSON 2=clientID 3=nodeTTLms 4=nodeID 5=indexTTLms.
// Returns {1} when granted, or {0, currentHolderJSON} when held by another.
var lockAcquireScript = redis.NewScript(`
local v = redis.call('GET', KEYS[1])
if v ~= false then
  local ok, h = pcall(cjson.decode, v)
  if not (ok and h.clientId == ARGV[2]) then
    return {0, v}
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
redis.call('SADD', KEYS[2], ARGV[4])
redis.call('PEXPIRE', KEYS[2], ARGV[5])
return {1}
`)

// atomic refresh: extend the node + index TTL iff WE still hold the node, so a
// stale heartbeat can never prolong another client's re-acquired lock.
// KEYS[1]=lock key, KEYS[2]=index set; ARGV[1]=clientID, ARGV[2]=nodeTTLms, ARGV[3]=indexTTLms.
var lockRefreshScript = redis.NewScript(`
local v = redis.call('GET', KEYS[1])
if v == false then return 0 end
local ok, h = pcall(cjson.decode, v)
if ok and h.clientId == ARGV[1] then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  redis.call('PEXPIRE', KEYS[2], ARGV[3])
  return 1
end
return 0
`)

// indexTTLFactor: the index set lives this many times the node TTL, so it never
// expires out from under a live member between heartbeat refreshes.
const indexTTLFactor = 3

// RedisLockStore is the Redis-backed cross-instance lock authority.
type RedisLockStore struct {
	rdb *redis.Client
}

// NewRedisLockStore dials redisURL (own client; go-redis pools internally) and
// verifies connectivity, so a misconfigured deployment fails loudly.
func NewRedisLockStore(ctx context.Context, redisURL string) (*RedisLockStore, error) {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}
	rdb := redis.NewClient(opt)
	if err := rdb.Ping(ctx).Err(); err != nil {
		_ = rdb.Close()
		return nil, err
	}
	return &RedisLockStore{rdb: rdb}, nil
}

func (s *RedisLockStore) Acquire(ctx context.Context, designID string, nodeIDs []string, holder LockHolder, ttl time.Duration) ([]string, LockMap, error) {
	payload, err := json.Marshal(holder)
	if err != nil {
		return nil, nil, err
	}
	setKey := lockSetKey(designID)
	ttlMs := ttl.Milliseconds()
	idxTTLMs := ttlMs * indexTTLFactor
	var granted []string
	denied := LockMap{}
	for _, nodeID := range nodeIDs {
		// One atomic step per node: grant-if-free-or-ours + index + TTL, else the
		// current holder. No SETNX->SADD gap and no unconditional re-lock SET.
		res, err := lockAcquireScript.Run(ctx, s.rdb,
			[]string{lockKey(designID, nodeID), setKey},
			payload, holder.ClientID, ttlMs, nodeID, idxTTLMs).Result()
		if err != nil {
			return granted, denied, err
		}
		arr, ok := res.([]interface{})
		if !ok || len(arr) == 0 {
			continue
		}
		code, _ := arr[0].(int64)
		if code == 1 {
			granted = append(granted, nodeID)
			continue
		}
		if len(arr) >= 2 { // denied: arr[1] is the current holder's JSON
			if cur, ok := arr[1].(string); ok {
				var h LockHolder
				if json.Unmarshal([]byte(cur), &h) == nil {
					denied[nodeID] = h
				}
			}
		}
	}
	return granted, denied, nil
}

func (s *RedisLockStore) Release(ctx context.Context, designID, clientID string, nodeIDs []string) error {
	setKey := lockSetKey(designID)
	for _, nodeID := range nodeIDs {
		if err := lockDelScript.Run(ctx, s.rdb, []string{lockKey(designID, nodeID), setKey}, clientID, nodeID).Err(); err != nil && err != redis.Nil {
			return err
		}
	}
	return nil
}

func (s *RedisLockStore) ReleaseAll(ctx context.Context, designID, clientID string) error {
	nodes, err := s.rdb.SMembers(ctx, lockSetKey(designID)).Result()
	if err != nil {
		return err
	}
	// Release is compare-and-delete by clientID, so handing it every indexed node
	// only drops the ones this client actually holds (and self-heals stale index
	// entries whose key has expired). No GET-then-decide TOCTOU needed.
	return s.Release(ctx, designID, clientID, nodes)
}

func (s *RedisLockStore) Refresh(ctx context.Context, designID, clientID string, ttl time.Duration) error {
	nodes, err := s.rdb.SMembers(ctx, lockSetKey(designID)).Result()
	if err != nil {
		return err
	}
	setKey := lockSetKey(designID)
	ttlMs := ttl.Milliseconds()
	idxTTLMs := ttlMs * indexTTLFactor
	for _, nodeID := range nodes {
		// Atomic compare-and-pexpire: extend the TTL only if WE still hold the node,
		// so a stale heartbeat can never prolong another client's re-acquired lock.
		_ = lockRefreshScript.Run(ctx, s.rdb,
			[]string{lockKey(designID, nodeID), setKey},
			clientID, ttlMs, idxTTLMs).Err()
	}
	return nil
}

func (s *RedisLockStore) Snapshot(ctx context.Context, designID string) (LockMap, error) {
	setKey := lockSetKey(designID)
	nodes, err := s.rdb.SMembers(ctx, setKey).Result()
	if err != nil {
		return nil, err
	}
	out := LockMap{}
	if len(nodes) == 0 {
		return out, nil
	}
	keys := make([]string, len(nodes))
	for i, nodeID := range nodes {
		keys[i] = lockKey(designID, nodeID)
	}
	vals, err := s.rdb.MGet(ctx, keys...).Result()
	if err != nil {
		return nil, err
	}
	var stale []string
	for i, v := range vals {
		str, ok := v.(string)
		if !ok || str == "" {
			stale = append(stale, nodes[i]) // key expired; drop from the index
			continue
		}
		var h LockHolder
		if json.Unmarshal([]byte(str), &h) == nil {
			out[nodes[i]] = h
		}
	}
	if len(stale) > 0 {
		s.rdb.SRem(ctx, setKey, stale)
	}
	return out, nil
}

func (s *RedisLockStore) Close() error { return s.rdb.Close() }
