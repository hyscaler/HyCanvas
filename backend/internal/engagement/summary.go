// Pure mappings for activity-feed summaries and notification text (doc 17 FR-12,
// FR-13). No I/O: given a type + payload + resolved actor name these build the
// one-line strings the feed and notification rows show. Unknown types and
// missing payload fields degrade to a generic phrase rather than failing.
package engagement

func pstr(p map[string]any, k string) string {
	if p == nil {
		return ""
	}
	if v, ok := p[k].(string); ok {
		return v
	}
	return ""
}

func actorName(name string) string {
	if name != "" {
		return name
	}
	return "Someone"
}

// summarizeActivity builds a one-line summary for an activity event (FR-12).
func summarizeActivity(typ, actor string, p map[string]any) string {
	who := actorName(actor)
	switch typ {
	case "edit":
		return who + " edited the design"
	case "comment":
		return who + " left a comment"
	case "reply":
		return who + " replied to a comment"
	case "resolve":
		if v, ok := p["resolved"].(bool); ok && !v {
			return who + " reopened a comment"
		}
		return who + " resolved a comment"
	case "reaction":
		if e := pstr(p, "emoji"); e != "" {
			return who + " reacted " + e
		}
		return who + " reacted to a comment"
	case "share":
		op := pstr(p, "op")
		mode := pstr(p, "mode")
		if op == "removed" {
			return who + " removed a person's access"
		}
		if op == "changed" {
			if mode != "" {
				return who + " changed a person's access to " + mode
			}
			return who + " changed a person's access"
		}
		if mode != "" {
			return who + " shared the design (" + mode + ")"
		}
		return who + " shared the design"
	case "link_change":
		switch pstr(p, "op") {
		case "disabled":
			return who + " disabled a share link"
		case "rotated":
			return who + " rotated a share link"
		case "updated":
			return who + " updated a share link"
		}
		return who + " created a share link"
	case "role_change":
		return who + " changed a role"
	case "task_assign":
		if a := pstr(p, "assigneeName"); a != "" {
			return who + " assigned a task to " + a
		}
		return who + " assigned a task"
	case "task_status":
		status := pstr(p, "status")
		label := status
		switch status {
		case "in_progress":
			label = "in progress"
		case "done":
			label = "done"
		case "open":
			label = "open"
		}
		if label != "" {
			return who + " set a task to " + label
		}
		return who + " updated a task"
	case "approval_request":
		return who + " requested approval"
	case "approval_decision":
		switch pstr(p, "decision") {
		case "approve":
			return who + " approved the design"
		case "reject":
			return who + " rejected the design"
		}
		return who + " made an approval decision"
	case "reopen":
		return who + " reopened the design for editing"
	default:
		return who + " updated the design"
	}
}

// notificationText builds the short text for a notification row (FR-13),
// phrased from the recipient's point of view.
func notificationText(typ, actor, designTitle string, p map[string]any) string {
	who := actorName(actor)
	on := ""
	if designTitle != "" {
		on = ` on "` + designTitle + `"`
	}
	switch typ {
	case "mention":
		return who + " mentioned you" + on
	case "reply":
		return who + " replied to your comment" + on
	case "task_assign":
		return who + " assigned you a task" + on
	case "share":
		if mode := pstr(p, "mode"); mode != "" {
			return who + " shared a design with you (" + mode + ")"
		}
		return who + " shared a design with you"
	case "approval_request":
		return who + " requested your approval" + on
	case "approval_decision":
		switch pstr(p, "decision") {
		case "approve":
			return who + " approved your design" + on
		case "reject":
			return who + " rejected your design" + on
		}
		return who + " responded to your approval request" + on
	default:
		return who + " sent you a notification"
	}
}
