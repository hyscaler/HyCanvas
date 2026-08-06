// Abuse guards for the ANONYMOUS side of the live audience (doc 28). These
// routes are reachable by anyone holding a share link, with no account, so two
// costs need bounding:
//
//	Writes: a script can loop on ask/vote/react. A per-IP-and-token token
//	bucket caps the sustained rate while leaving a real attendee (who taps a
//	handful of times a minute) untouched, and reactions fan out to every
//	connected editor, so throttling here also protects the socket.
//
//	Password verification: the state endpoint is POLLED every few seconds by
//	every viewer, and a password-protected link runs scrypt (16 MiB, N=16384)
//	on each call. A few hundred attendees would peg the CPU. Successful
//	resolutions are memoized briefly, keyed by the token plus a hash of the
//	supplied password; FAILURES are never cached, so guessing stays as
//	expensive as it was.
package httpapi

import (
	"crypto/sha256"
	"encoding/hex"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
)

const (
	// Budgets are per (client address, token) and must survive NAT: a room of
	// attendees on one venue wifi shares a single public address, which is the
	// NORMAL case for this feature, not the abusive one. They are sized to stop
	// a script (thousands/sec) while leaving a full room unthrottled.
	//
	// Writes: a poll opening makes every attendee vote within a few seconds, so
	// the burst has to absorb a whole room at once.
	audienceWriteRatePerSec = 10.0
	audienceWriteBurst      = 150.0
	// Reads (the state poll): each viewer polls a couple of times per 5s, so a
	// 100-person room is ~40 req/s from one address. Cheap too - the resolve
	// cache keeps scrypt out of the path - so the ceiling is only here to stop
	// something pathological.
	audienceReadRatePerSec = 100.0
	audienceReadBurst      = 600.0
	// How long a verified link resolution is trusted before scrypt runs again.
	audienceResolveTTL = 60 * time.Second
	// Hard cap on tracked buckets. The client address comes from RealIP, which
	// trusts X-Forwarded-For, so a directly-exposed instance can be fed endless
	// distinct keys; without a cap the abuse guard becomes the memory-exhaustion
	// vector it exists to prevent.
	audienceMaxBuckets = 20_000
)

type audienceBucket struct {
	tokens float64
	last   time.Time
}

var (
	audienceRateMu sync.Mutex
	audienceRates  = map[string]*audienceBucket{}
	audienceSweep  time.Time
)

// allowAudience consumes one token for the caller at the given rate/burst,
// refilling from elapsed time. Returns false when the caller is over budget.
func allowAudience(key string, now time.Time, ratePerSec, burst float64) bool {
	audienceRateMu.Lock()
	defer audienceRateMu.Unlock()
	// Opportunistic sweep so idle keys do not accumulate.
	if now.Sub(audienceSweep) > 10*time.Minute {
		for k, b := range audienceRates {
			if now.Sub(b.last) > 10*time.Minute {
				delete(audienceRates, k)
			}
		}
		audienceSweep = now
	}
	b := audienceRates[key]
	if b == nil {
		// At the cap, drop everything and start over rather than growing without
		// bound. Buckets are soft state; the worst case is one forgiven burst.
		if len(audienceRates) >= audienceMaxBuckets {
			audienceRates = make(map[string]*audienceBucket, 1024)
			audienceSweep = now
		}
		b = &audienceBucket{tokens: burst, last: now}
		audienceRates[key] = b
	}
	if now.After(b.last) {
		b.tokens += now.Sub(b.last).Seconds() * ratePerSec
		if b.tokens > burst {
			b.tokens = burst
		}
		b.last = now
	}
	if b.tokens < 1 {
		return false
	}
	b.tokens--
	return true
}

// audienceRateKey identifies a caller: the client address plus the link token,
// so one link cannot be used to exhaust another's budget and one host cannot
// spread a flood across links.
func audienceRateKey(r *http.Request, token string) string {
	host := clientIP(r)
	if h, _, err := net.SplitHostPort(host); err == nil {
		host = h
	}
	return host + "\x1f" + token
}

// audienceRateLimit rejects a caller that is over budget with 429 before any
// database or password work happens. Reads and writes carry separate budgets
// and separate keys: the state poll is high-frequency by design and must never
// consume the budget an attendee needs to ask a question.
func audienceRateLimit(kind string, rate, burst float64) func(http.HandlerFunc) http.HandlerFunc {
	return func(next http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			key := kind + "\x1f" + audienceRateKey(r, chi.URLParam(r, "token"))
			if !allowAudience(key, time.Now(), rate, burst) {
				w.Header().Set("Retry-After", "5")
				Problem(w, r, http.StatusTooManyRequests, "Too Many Requests", "you are sending requests too quickly; slow down and try again")
				return
			}
			next(w, r)
		}
	}
}

// audienceWriteLimit / audienceReadLimit are the two budgets the routes use.
func audienceWriteLimit(next http.HandlerFunc) http.HandlerFunc {
	return audienceRateLimit("w", audienceWriteRatePerSec, audienceWriteBurst)(next)
}

func audienceReadLimit(next http.HandlerFunc) http.HandlerFunc {
	return audienceRateLimit("r", audienceReadRatePerSec, audienceReadBurst)(next)
}

type resolvedLink struct {
	designID string
	at       time.Time
}

var (
	audienceResolveMu    sync.Mutex
	audienceResolveCache = map[string]resolvedLink{}
)

// audienceResolveKey binds a cache entry to both the token and the exact
// password presented, so a wrong password can never ride a right one's entry.
func audienceResolveKey(token, password string) string {
	sum := sha256.Sum256([]byte(token + "\x1f" + password))
	return hex.EncodeToString(sum[:])
}

func cachedResolve(token, password string, now time.Time) (string, bool) {
	if password == "" {
		return "", false // no scrypt on this path; always resolve fresh
	}
	audienceResolveMu.Lock()
	defer audienceResolveMu.Unlock()
	e, ok := audienceResolveCache[audienceResolveKey(token, password)]
	if !ok || now.Sub(e.at) > audienceResolveTTL {
		return "", false
	}
	return e.designID, true
}

func rememberResolve(token, password, designID string, now time.Time) {
	if password == "" {
		return
	}
	audienceResolveMu.Lock()
	defer audienceResolveMu.Unlock()
	if len(audienceResolveCache) > 4096 { // bound the map; the TTL is short
		audienceResolveCache = map[string]resolvedLink{}
	}
	audienceResolveCache[audienceResolveKey(token, password)] = resolvedLink{designID: designID, at: now}
}
