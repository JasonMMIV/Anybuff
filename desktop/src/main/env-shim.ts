/**
 * Import-time environment defaults for the Electron main process.
 *
 * MUST be the first import of the main entry: @codebuff/sdk's bundled
 * common/env validates web-era variables the moment any contract module is
 * evaluated. Local BYOK ships no web backend, so we satisfy the schema with
 * inert placeholders instead of patching upstream (keeps git merges clean).
 */
process.env.NEXT_PUBLIC_CB_ENVIRONMENT ||= 'test'
process.env.NEXT_PUBLIC_CODEBUFF_APP_URL ||= 'http://localhost:3000'
process.env.NEXT_PUBLIC_WEB_PORT ||= '3000'
process.env.NEXT_PUBLIC_SUPPORT_EMAIL ||= 'support@anybuff.local'
process.env.NEXT_PUBLIC_POSTHOG_API_KEY ||= 'disabled-posthog-key'
process.env.NEXT_PUBLIC_POSTHOG_HOST_URL ||= 'https://us.i.posthog.com'
process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ||= 'pk_test_placeholder'
process.env.NEXT_PUBLIC_STRIPE_CUSTOMER_PORTAL ||=
  'https://billing.stripe.com/p/login/test_placeholder'

export {}
