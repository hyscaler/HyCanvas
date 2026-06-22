package httpapi

import "net/http"

// corsMiddleware echoes CORS headers for allowed cross-origin requests and
// answers preflight OPTIONS, mirroring the former NestJS enableCors: the matched
// origin is echoed back (never "*") with credentials allowed, so the dev
// frontend on :3000 can call the API on :8005 with cookies. In production the
// frontend is served same-origin by this binary, so no Origin header is sent and
// this is a no-op. allowOrigin decides which origins are permitted.
func corsMiddleware(allowOrigin func(string) bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" && allowOrigin(origin) {
				h := w.Header()
				h.Set("Access-Control-Allow-Origin", origin)
				h.Add("Vary", "Origin")
				h.Set("Access-Control-Allow-Credentials", "true")
				if r.Method == http.MethodOptions {
					reqHeaders := r.Header.Get("Access-Control-Request-Headers")
					if reqHeaders == "" {
						reqHeaders = "Content-Type, Authorization"
					}
					h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
					h.Set("Access-Control-Allow-Headers", reqHeaders)
					h.Set("Access-Control-Max-Age", "600")
					w.WriteHeader(http.StatusNoContent)
					return
				}
			} else if r.Method == http.MethodOptions {
				// Preflight from a disallowed origin: no CORS headers, end here.
				w.WriteHeader(http.StatusNoContent)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
