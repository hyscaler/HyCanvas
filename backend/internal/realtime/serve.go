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

	c := h.Join(id, designID, time.Now().UnixMilli())
	defer h.Leave(c)

	// Writer pump: drain the connection's outbound queue.
	go func() {
		for {
			select {
			case <-ctx.Done():
				return
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
	t, _ := msg["t"].(string)
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
