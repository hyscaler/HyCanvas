// Notification-preference defaults + canonical type lists (doc 17 FR-13). Pure,
// dependency-free so the emitter and the read service share one definition.
package engagement

// notificationTypes is every notification type the center supports (FR-13).
var notificationTypes = []string{"mention", "reply", "task_assign", "share", "approval_request", "approval_decision", "workspace_invite", "access_request", "access_decision"}

var notificationTypeSet = func() map[string]bool {
	m := map[string]bool{}
	for _, t := range notificationTypes {
		m[t] = true
	}
	return m
}()

// activityTypes is every activity type the feed can filter by (FR-12).
var activityTypeSet = func() map[string]bool {
	m := map[string]bool{}
	for _, t := range []string{
		"edit", "comment", "resolve", "reply", "reaction", "share", "link_change",
		"role_change", "task_assign", "task_status", "approval_request",
		"approval_decision", "reopen",
	} {
		m[t] = true
	}
	return m
}()

// defaultEmailTypes returns the email-channel defaults when a user has no stored
// preference: mentions, replies, assignments, shares, and approvals.
func defaultEmailTypes() []string {
	return []string{"mention", "reply", "task_assign", "share", "approval_request", "approval_decision", "access_request", "access_decision"}
}

// defaultPushTypes mirrors the email defaults for the web-push channel.
func defaultPushTypes() []string { return defaultEmailTypes() }

// sanitizeTypes drops unknown / duplicate entries from an untrusted type list.
func sanitizeTypes(raw []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, v := range raw {
		if notificationTypeSet[v] && !seen[v] {
			seen[v] = true
			out = append(out, v)
		}
	}
	return out
}
