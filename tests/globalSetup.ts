import { execSync } from 'node:child_process'

export default function setup() {
  const url = process.env.TEST_DATABASE_URL
  if (!url) {
    throw new Error('TEST_DATABASE_URL environment variable is required')
  }

  const match = url.match(/\/([^/?]+)(?:\?|$)/)
  const dbName = match ? match[1] : ''
  if (!dbName.endsWith('test')) {
    throw new Error(`Refusing to migrate non-test database: ${dbName}`)
  }

  execSync(`npx prisma migrate deploy --schema prisma/schema.prisma`, {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'inherit',
  })
}
