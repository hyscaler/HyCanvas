package realtime

import (
	"context"
	"encoding/json"
	"time"

	"github.com/coder/websocket"
)

// Serve runs the read/write pumps for one accepted WebSocket connection: it
// joins the room (sending welcome/roster/locks + broadcasting join), relays
// inbound frames, and on disconnect leaves the room (releasing locks +
// broadcasting leave). Blocks until the connection closes.
func (h *Hub) Serve(ctx context.Context, ws *websocket.Conn, id PeerIdentity, designID string) {
	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	// Cap an inbound frame (defense in depth). coder/websocket defaults to 32KiB,
	// which a real design's initial Yjs sync exceeds, so this both bounds abuse and
	// lets large docs sync; an over-limit frame fails the read and closes the conn.
	ws.SetReadLimit(maxWSReadBytes)

	// Join refuses a banned user (under h.mu, so a ban racing this join can't slip
	// through) and stores `cancel` on the conn so a kick can force-disconnect it.
	c := h.joinConn(id, designID, time.Now().UnixMilli(), cancel)
	if c == nil {
		_ = ws.Write(ctx, websocket.MessageText, frame(map[string]any{"t": "moderated", "action": "ban", "designId": designID}))
		return
	}
	defer h.Leave(c)

	// Writer pump: drain the connection's outbound queue.
	go func() {
		for {
			select {
			case <-ctx.Done():
				// On teardown, best-effort flush any already-queued frames (e.g. the
				// {t:"moderated"} kick notice) so the client learns why it is closing,
				// then return. A fresh short-deadline context is used because ctx is
				// already cancelled. Non-blocking: stop at the first empty/failed write.
				for {
					select {
					case msg, ok := <-c.send:
						if !ok {
							return
						}
						flushCtx, fcancel := context.WithTimeout(context.Background(), time.Second)
						err := ws.Write(flushCtx, websocket.MessageText, msg)
						fcancel()
						if err != nil {
							return
						}
					default:
						return
					}
				}
			case msg, ok := <-c.send:
				if !ok {
					return
				}
				writeCtx, wcancel := context.WithTimeout(ctx, 10*time.Second)
				err := ws.Write(writeCtx, websocket.MessageText, msg)
				wcancel()
				if err != nil {
					cancel()
					return
				}
			}
		}
	}()

	// Reader pump: dispatch inbound frames until the socket errors/closes.
	for {
		typ, data, err := ws.Read(ctx)
		if err != nil {
			return
		}
		if typ != websocket.MessageText {
			continue // binary is unused; the sync payload is base64 in a JSON frame
		}
		h.dispatch(ctx, c, data)
	}
}

// dispatch routes one inbound JSON frame by its `t` discriminator.
func (h *Hub) dispatch(ctx context.Context, c *conn, data []byte) {
	var msg map[string]any
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}
	// Any inbound frame proves the connection is alive and keeps its locks from
	// being swept (FR-8 heartbeat timeout).
	h.touch(c)
	t, _ := msg["t"].(string)
	// Per-connection flood guard, applied ONLY to recoverable frames. Dropping a
	// presence or lock/unlock frame is safe: a newer presence supersedes it, and
	// the lock map is an authoritative re-assertable snapshot. SYNC frames are
	// EXEMPT - a y-protocols UPDATE is delivered exactly once and is never
	// retransmitted (the relay holds no Y.Doc to re-emit it), so dropping one would
	// diverge peers until a reconnect; sync abuse is bounded per-frame instead by
	// SetReadLimit + the maxUpdateBytes decode cap. HEARTBEAT is exempt so a flood
	// never starves the liveness ping and wrongly sweeps a live client's locks.
	switch t {
	case "presence", "lock", "unlock":
		if !c.rate.allow(time.Now().UnixMilli(), maxFramesPerSec, maxFrameBurst) {
			return
		}
	}
	switch t {
	case "presence":
		state, _ := msg["state"].(map[string]any)
		h.HandlePresence(c, state)
	case "sync":
		if m, ok := msg["m"].(string); ok {
			h.HandleSync(ctx, c, m)
		}
	case "lock":
		h.HandleLock(c, asStrings(msg["ids"]))
	case "unlock":
		h.HandleUnlock(c, asStrings(msg["ids"]))
	case "spotlight":
		mode, _ := msg["mode"].(string)
		vp, _ := msg["viewport"].(map[string]any)
		h.HandleSpotlight(c, mode, vp)
	case "moderate":
		action, _ := msg["action"].(string)
		target, _ := msg["userId"].(string)
		h.HandleModerate(c, action, target)
	case "facilitator":
		action, _ := msg["action"].(string)
		target, _ := msg["target"].(string)
		h.HandleFacilitator(c, action, target)
	case "protect":
		action, _ := msg["action"].(string)
		h.HandleProtect(c, action, asStrings(msg["nodes"]))
	case "heartbeat":
		// Liveness already recorded by touch(); an idle but live client sends this
		// to keep its locks + presence from timing out.
	}
}

func asStrings(v any) []string {
	arr, ok := v.([]any)
	if !ok {
		return nil
	}
	out := make([]string, 0, len(arr))
	for _, x := range arr {
		if s, ok := x.(string); ok {
			out = append(out, s)
		}
	}
	return out
}
