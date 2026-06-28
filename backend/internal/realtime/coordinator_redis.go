package realtime

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync/atomic"

	"github.com/google/uuid"
	"github.com/redis/go-redis/v9"
)

// fanoutChannel is the single Redis pub/sub channel every gateway instance
// publishes to and subscribes to. One shared channel (rather than one per design)
// keeps subscription lifecycle trivial; each instance filters delivered frames to
// the designs it actually has local connections for (deliverRemote is a no-op for
// an unknown room). For very large instance counts a per-design channel would cut
// cross-talk, at the cost of subscribe/unsubscribe churn on room create/destroy.
const fanoutChannel = "hc:rt:fanout"

// fanoutBuffer bounds the outbound publish queue. A full queue drops frames
// rather than blocking the hub; peers reconverge through the durable snapshot +
// the Yjs sync handshake on the next reconnect/edit, so a dropped fan-out frame
// is a transient awareness gap, never lost document state.
const fanoutBuffer = 1024

// wireMsg is one fanned-out frame on the shared channel. Origin lets a subscriber
// skip its own publishes (it already broadcast them locally). Payload is the
// exact JSON frame the hub would broadcast to a local client.
type wireMsg struct {
	Origin   string          `json:"o"`
	DesignID string          `json:"d"`
	Except   string          `json:"x"`
	Target   string          `json:"t,omitempty"` // addressed to one instance; "" = all
	Payload  json.RawMessage `json:"p"`
}

// RedisCoordinator fans room frames across gateway instances via Redis pub/sub.
type RedisCoordinator struct {
	rdb        *redis.Client
	instanceID string
	out        chan []byte
	dropped    atomic.Int64 // count of fan-out frames dropped on a full queue
}

// NewRedisCoordinator dials redisURL (a redis:// or rediss:// URL) and verifies
// connectivity with a ping. Returns an error if the URL is invalid or the server
// is unreachable, so a misconfigured deployment fails loudly rather than silently
// degrading to a split-brain single instance.
func NewRedisCoordinator(ctx context.Context, redisURL string) (*RedisCoordinator, error) {
	opt, err := redis.ParseURL(redisURL)
	if err != nil {
		return nil, err
	}
	rdb := redis.NewClient(opt)
	if err := rdb.Ping(ctx).Err(); err != nil {
		_ = rdb.Close()
		return nil, err
	}
	return &RedisCoordinator{
		rdb:        rdb,
		instanceID: uuid.NewString(),
		out:        make(chan []byte, fanoutBuffer),
	}, nil
}

// InstanceID is this gateway instance's stable id (see Coordinator.InstanceID).
func (rc *RedisCoordinator) InstanceID() string { return rc.instanceID }

// Publish enqueues a frame for ALL peer instances (non-blocking, lock-safe).
func (rc *RedisCoordinator) Publish(designID, except string, payload []byte) {
	rc.publish(designID, "", except, payload)
}

// PublishTo enqueues a frame addressed to a single peer instance (the requester),
// so a roster re-announce reaches only it instead of fanning out everywhere.
func (rc *RedisCoordinator) PublishTo(designID, targetInstanceID, except string, payload []byte) {
	rc.publish(designID, targetInstanceID, except, payload)
}

// publish is the shared enqueue path. Non-blocking and safe under the hub lock:
// a full queue drops the frame (see fanoutBuffer).
func (rc *RedisCoordinator) publish(designID, target, except string, payload []byte) {
	b, err := json.Marshal(wireMsg{
		Origin:   rc.instanceID,
		DesignID: designID,
		Except:   except,
		Target:   target,
		Payload:  json.RawMessage(payload),
	})
	if err != nil {
		return
	}
	select {
	case rc.out <- b:
	default:
		// Queue full: drop. Peers reconverge via the durable snapshot + the Yjs
		// sync handshake, so a dropped fan-out frame is a transient awareness gap,
		// never lost document state. Surface saturation so it is not silent: log on
		// the first drop and every 1000th thereafter.
		if n := rc.dropped.Add(1); n == 1 || n%1000 == 0 {
			slog.Warn("realtime: redis fan-out queue full, dropping frame", "dropped_total", n)
		}
	}
}

// Start runs the publisher pump (drains `out` to the channel) and the subscriber
// pump (delivers peers' frames via `deliver`). Both stop when ctx is done.
func (rc *RedisCoordinator) Start(ctx context.Context, deliver func(designID, except string, payload []byte)) {
	go rc.publishPump(ctx)
	go rc.subscribePump(ctx, deliver)
}

func (rc *RedisCoordinator) publishPump(ctx context.Context) {
	for {
		select {
		case <-ctx.Done():
			return
		case b := <-rc.out:
			if err := rc.rdb.Publish(ctx, fanoutChannel, b).Err(); err != nil && ctx.Err() == nil {
				slog.Warn("realtime: redis publish failed", "err", err)
			}
		}
	}
}

func (rc *RedisCoordinator) subscribePump(ctx context.Context, deliver func(string, string, []byte)) {
	sub := rc.rdb.Subscribe(ctx, fanoutChannel)
	defer func() { _ = sub.Close() }()
	ch := sub.Channel()
	for {
		select {
		case <-ctx.Done():
			return
		case m, ok := <-ch:
			if !ok {
				return
			}
			var wm wireMsg
			if json.Unmarshal([]byte(m.Payload), &wm) != nil {
				continue
			}
			if wm.Origin == rc.instanceID {
				continue // our own frame, already broadcast to local clients
			}
			if wm.Target != "" && wm.Target != rc.instanceID {
				continue // addressed to a different instance (targeted re-announce)
			}
			deliver(wm.DesignID, wm.Except, []byte(wm.Payload))
		}
	}
}

// Close releases the Redis connection pool.
func (rc *RedisCoordinator) Close() error { return rc.rdb.Close() }
