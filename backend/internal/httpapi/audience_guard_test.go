package httpapi

import (
	"fmt"
	"testing"
	"time"
)

// The anonymous audience routes are reachable by anyone holding a share link,
// so the write budget must actually run out, refill over time, and be scoped
// per caller rather than shared globally.
func TestAllowAudience(t *testing.T) {
	now := time.Now()
	key := "w\x1f1.2.3.4\x1ftok"
	spent := 0
	for i := 0; i < int(audienceWriteBurst)+5; i++ {
		if allowAudience(key, now, audienceWriteRatePerSec, audienceWriteBurst) {
			spent++
		}
	}
	if spent != int(audienceWriteBurst) {
		t.Fatalf("burst allowed %d writes, want %d", spent, int(audienceWriteBurst))
	}
	if allowAudience(key, now, audienceWriteRatePerSec, audienceWriteBurst) {
		t.Fatal("budget did not run out")
	}
	// A different caller has its own budget.
	if !allowAudience("w\x1f5.6.7.8\x1ftok", now, audienceWriteRatePerSec, audienceWriteBurst) {
		t.Fatal("one caller exhausted another's budget")
	}
	// Tokens refill with elapsed time.
	if !allowAudience(key, now.Add(2*time.Second), audienceWriteRatePerSec, audienceWriteBurst) {
		t.Fatal("budget never refills")
	}
}

// The budgets must fit the feature's OWN traffic: attendees share one public
// address behind NAT (venue wifi is the normal case), so a full room must pass.
// Reads and writes are separately keyed so the state poll cannot starve the
// budget an attendee needs to ask a question.
func TestAudienceBudgetsFitARoomBehindNAT(t *testing.T) {
	now := time.Now()
	const viewers = 100
	// 100 viewers x 2 polls per 5s = 40 req/s, sustained for 30s, one address.
	blocked := 0
	for tick := 0; tick < 30; tick++ {
		at := now.Add(time.Duration(tick) * time.Second)
		for i := 0; i < 40; i++ {
			if !allowAudience("r\x1fnat\x1ftok", at, audienceReadRatePerSec, audienceReadBurst) {
				blocked++
			}
		}
	}
	if blocked > 0 {
		t.Fatalf("read budget blocked %d of a %d-viewer room's polls", blocked, viewers)
	}
	// A poll opens: every attendee votes within two seconds, same address.
	for i := 0; i < viewers; i++ {
		if !allowAudience("w\x1fnat\x1ftok", now.Add(time.Second), audienceWriteRatePerSec, audienceWriteBurst) {
			t.Fatalf("write budget blocked attendee %d voting on an open poll", i)
		}
	}
	// ...but a script hammering the same address still gets cut off.
	stopped := false
	for i := 0; i < 5000; i++ {
		if !allowAudience("w\x1fnat\x1ftok", now.Add(time.Second), audienceWriteRatePerSec, audienceWriteBurst) {
			stopped = true
			break
		}
	}
	if !stopped {
		t.Fatal("a 5000-request flood was never throttled")
	}
}

// Forged X-Forwarded-For headers can mint endless distinct keys; the map must
// not grow without bound (the guard would become the exhaustion vector).
func TestAudienceBucketMapIsCapped(t *testing.T) {
	now := time.Now()
	for i := 0; i < audienceMaxBuckets+500; i++ {
		allowAudience(fmt.Sprintf("w\x1f10.0.%d.%d\x1ftok", i/256, i%256), now, audienceWriteRatePerSec, audienceWriteBurst)
	}
	audienceRateMu.Lock()
	n := len(audienceRates)
	audienceRateMu.Unlock()
	if n > audienceMaxBuckets {
		t.Fatalf("tracked %d buckets, cap is %d", n, audienceMaxBuckets)
	}
}

// Only SUCCESSFUL password resolutions are memoized, and only for the exact
// token+password pair, so a wrong password can never ride a right one's entry
// and guessing stays as expensive as scrypt makes it.
func TestAudienceResolveCache(t *testing.T) {
	now := time.Now()
	rememberResolve("tok", "hunter2", "design-1", now)
	if got, ok := cachedResolve("tok", "hunter2", now); !ok || got != "design-1" {
		t.Fatalf("cachedResolve = (%q, %v), want design-1", got, ok)
	}
	if _, ok := cachedResolve("tok", "wrong", now); ok {
		t.Fatal("a different password hit the cache")
	}
	if _, ok := cachedResolve("other", "hunter2", now); ok {
		t.Fatal("a different token hit the cache")
	}
	if _, ok := cachedResolve("tok", "hunter2", now.Add(audienceResolveTTL+time.Second)); ok {
		t.Fatal("entry outlived its TTL")
	}
	// Passwordless links never cache (nothing expensive to skip).
	rememberResolve("tok2", "", "design-2", now)
	if _, ok := cachedResolve("tok2", "", now); ok {
		t.Fatal("passwordless resolution was cached")
	}
}
