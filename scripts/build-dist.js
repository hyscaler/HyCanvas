// Builds the self-contained production bundle in dist/:
//   - the Go backend compiled to a single static binary (dist/hycanvas),
//     which embeds the SQL migrations, seed catalogs, and fonts;
//   - the statically-exported Next.js frontend, embedded INTO the binary via
//     go:embed (internal/webui), served on the same port. No sidecar folder.
//
// The binary is built for the host platform (for local runs / PM2). The
// container image builds its own Linux binary in a Go stage (see Dockerfile),
// so this script is not used inside Docker. There is no npm install in dist and
// no Node runtime: the bundle is the binary plus static files.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const BACKEND_GO = path.join(ROOT_DIR, 'backend');
const FRONTEND_OUT = path.join(ROOT_DIR, 'frontend', 'out');
const WEBUI_PUBLIC = path.join(BACKEND_GO, 'internal', 'webui', 'public');
const BINARY_NAME = 'hycanvas';

function log(message) {
  console.log(`\n[build-dist] ${message}`);
}

function exec(command, options = {}) {
  log(`Running: ${command}`);
  execSync(command, { stdio: 'inherit', cwd: ROOT_DIR, ...options });
}

// gitVersion returns `git describe` (tag/commit, with -dirty), falling back to
// the short commit, then "dev" outside a git checkout. Stamped into the binary.
function gitVersion() {
  for (const cmd of ['git describe --tags --always --dirty', 'git rev-parse --short HEAD']) {
    try {
      const out = execSync(cmd, { cwd: ROOT_DIR, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
      if (out) return out;
    } catch {
      // try the next form
    }
  }
  return 'dev';
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) {
    log(`Warning: source does not exist: ${src}`);
    return;
  }
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function main() {
  try {
    // 1. Clean dist and the Next.js cache.
    log('Cleaning dist directory...');
    if (fs.existsSync(DIST_DIR)) {
      fs.rmSync(DIST_DIR, { recursive: true, force: true });
    }
    fs.mkdirSync(DIST_DIR, { recursive: true });

    const nextCacheDir = path.join(ROOT_DIR, 'frontend', '.next');
    if (fs.existsSync(nextCacheDir)) {
      log('Cleaning Next.js cache...');
      fs.rmSync(nextCacheDir, { recursive: true, force: true });
    }

    // 2. Build the shared @hc/* packages (the frontend imports them).
    log('Building shared packages...');
    exec('npm run build:packages');

    // 3. Build the frontend as a static export (BUILD_DIST routes the API to /api).
    log('Building frontend...');
    exec('npm run build:dist -w frontend', {
      env: { ...process.env, NODE_ENV: 'production' },
    });

    // 4. Stage the frontend export inside the Go module so go:embed bakes it into
    //    the binary (single self-contained file, no sidecar public/ folder). The
    //    embed dir is build-only and gitignored, so just clear and refill it.
    log('Staging frontend into the binary (go:embed)...');
    fs.rmSync(WEBUI_PUBLIC, { recursive: true, force: true });
    copyRecursive(FRONTEND_OUT, WEBUI_PUBLIC);

    // 5. Compile the Go backend to a single static binary (now embedding the
    //    frontend via -tags embed). CGO is disabled so it has no libc dependency
    //    on a slim base. The git version is stamped into the binary for boot logs
    //    and the health endpoints.
    const version = gitVersion();
    log(`Building Go backend binary (embedded frontend, version ${version})...`);
    exec(
      `go build -tags embed -trimpath -ldflags "-s -w -X main.version=${version}" -o ${path.join(DIST_DIR, BINARY_NAME)} ./cmd/api`,
      { cwd: BACKEND_GO, env: { ...process.env, CGO_ENABLED: '0' } },
    );

    log('Build completed successfully.');
    log(`Output: ${path.join(DIST_DIR, BINARY_NAME)} (single self-contained binary)`);
    log('To run the production build (from the repo root):');
    log('  npm run start:dist:only      # loads .env, runs dist/hycanvas');
    log('or directly:');
    log(`  DATABASE_URL=... JWT_SECRET=... ./dist/${BINARY_NAME}`);
  } catch (error) {
    console.error('\n[build-dist] Build failed:', error.message);
    process.exit(1);
  }
}

main();
