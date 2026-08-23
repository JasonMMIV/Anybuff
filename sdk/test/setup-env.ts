/**
 * Provide sensible defaults for required client env vars during SDK tests.
 * Keeps tests from failing when a developer hasn't exported the full web env.
 */
const testDefaults: Record<string, string> = {
  NEXT_PUBLIC_CB_ENVIRONMENT: 'test',
  NEXT_PUBLIC_CODEBUFF_APP_URL: 'http://localhost:3000',
  NEXT_PUBLIC_SUPPORT_EMAIL: 'support@codebuff.com',
  NEXT_PUBLIC_POSTHOG_API_KEY: 'test-posthog-key',
  NEXT_PUBLIC_POSTHOG_HOST_URL: 'https://us.i.posthog.com',
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: 'pk_test_placeholder',
  NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL:
    'https://billing.stripe.com/p/login/test_placeholder',
  NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION_ID: 'test-verification',
  NEXT_PUBLIC_WEB_PORT: '3000',
}

const serverDefaults: Record<string, string> = {
  OPEN_ROUTER_API_KEY: 'test',
  OPENAI_API_KEY: 'test',
  SERPER_API_KEY: 'test',
  // Direct-provider handlers throw before fetch when their key is unset, so
  // give the mocked-fetch tests a dummy — without these, whether the CrofAI/
  // MiMo routing tests pass depends on the developer's shell env.
  CROF_AI_API_KEY: 'test',
  RUNINFRA_GATEWAY_KEY: 'test',
  MIMO_API_KEY: 'test',
  PORT: '4242',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  CODEBUFF_GITHUB_ID: 'test-id',
  CODEBUFF_GITHUB_SECRET: 'test-secret',
  NEXTAUTH_SECRET: 'test-secret',
  STRIPE_SECRET_KEY: 'sk_test_dummy',
  STRIPE_WEBHOOK_SECRET_KEY: 'whsec_dummy',
  STRIPE_TEAM_FEE_PRICE_ID: 'price_test',
  LOOPS_API_KEY: 'test',
  DISCORD_PUBLIC_KEY: 'test',
  DISCORD_BOT_TOKEN: 'test',
  DISCORD_APPLICATION_ID: 'test',
}

for (const [key, value] of Object.entries(testDefaults)) {
  if (!process.env[key]) {
    process.env[key] = value
  }
}

for (const [key, value] of Object.entries(serverDefaults)) {
  if (!process.env[key]) {
    process.env[key] = value
  }
}

if (process.env.CI !== 'true' && process.env.CI !== '1') {
  process.env.CI = 'true'
}

// Hint to downstream code that this is a test runtime
process.env.NODE_ENV ||= 'test'
process.env.BUN_ENV ||= 'test'

// ---------------------------------------------------------------------------
// AnyBuff BYOK test fixture: give mocked-fetch tests a resolvable provider
// config so getModelForRequest can route common model strings without any
// real endpoint. The fetch layer is mocked per-test; baseURL is irrelevant.
// ---------------------------------------------------------------------------
import fs from 'fs'
import os from 'os'
import path from 'path'

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anybuff-sdk-fixture-'))
const fixturePath = path.join(fixtureDir, 'anybuff.json')
fs.writeFileSync(
  fixturePath,
  JSON.stringify({
    providers: {
      openai: {
        type: 'openai-compatible',
        baseURL: 'https://api.openai.com/v1',
        apiKeyEnv: 'OPENAI_API_KEY',
        models: ['gpt-5.6-luna'],
      },
      anthropic: {
        type: 'anthropic-compatible',
        baseURL: 'https://api.anthropic.com',
        apiKeyEnv: 'ANTHROPIC_API_KEY',
        models: ['claude-test'],
      },
    },
  }),
)
process.env.ANYBUFF_PROVIDER_CONFIG = fixturePath
process.env.OPENAI_API_KEY ||= 'test-key'
process.env.ANTHROPIC_API_KEY ||= 'test-key'

// No test anywhere ships telemetry to the production Axiom dataset, even if the
// caller's environment claims NEXT_PUBLIC_CB_ENVIRONMENT is prod. Desktop server
// children are spawned with { ...process.env }, so they inherit this too.
// An explicit override still wins (freebuff-desktop's log-shipper.test.ts opts in).
process.env.FREEBUFF_SHIP_LOGS ??= 'false'
