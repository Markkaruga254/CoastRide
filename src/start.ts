import { listen } from './http/server.js'

// Explicit executable entry point for containers and local development.
try {
  await listen()
} catch {
  process.exitCode = 1
}
