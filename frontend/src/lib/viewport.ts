// The viewport meta every page sets in its <Head> (with key "viewport", which
// replaces Next's default tag). viewport-fit=cover lets bottom bars pad for
// the home indicator on notched phones; zoom stays enabled. Set per page
// rather than in _app: a next/head import in _app breaks the editor page's
// chunks under the Turbopack dev server.
export const VIEWPORT = "width=device-width, initial-scale=1, viewport-fit=cover";
