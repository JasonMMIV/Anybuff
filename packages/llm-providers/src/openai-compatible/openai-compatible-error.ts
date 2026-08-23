import { z } from 'zod/v4'

import type { ZodType } from 'zod/v4'

const openaiCompatibleErrorPayloadSchema = z.object({
  error: z.object({
    message: z.string(),

    /**
     * OpenRouter returns a `code` number, Together AI a string.
     */
    type: z.string().nullish(),
    param: z.any().nullish(),
    code: z.union([z.string(), z.number()]).nullish(),
    status: z.string().nullish(),
    details: z.array(z.any()).nullish(),
  }),
})

/**
 * Tolerant of gateways that wrap the error payload in an array
 * (e.g. `[{ error: {...} }]`): pick the first element that carries an
 * `error` field instead of failing schema validation.
 */
export const openaiCompatibleErrorDataSchema = z.preprocess((value) => {
  if (!Array.isArray(value)) {
    return value
  }

  return (
    value.find((item) => item && typeof item === 'object' && 'error' in item) ??
    value
  )
}, openaiCompatibleErrorPayloadSchema)

export type OpenAICompatibleErrorData = z.infer<
  typeof openaiCompatibleErrorDataSchema
>

export type ProviderErrorStructure<T> = {
  errorSchema: ZodType<T>
  errorToMessage: (data: T) => string
}

export const defaultOpenAICompatibleErrorStructure: ProviderErrorStructure<OpenAICompatibleErrorData> =
  {
    errorSchema: openaiCompatibleErrorDataSchema,
    errorToMessage: (data) => {
      const reason = getGoogleRpcReason(data.error.details)
      if (reason && !data.error.message.includes(reason)) {
        return `${data.error.message} (${reason})`
      }
      return data.error.message
    },
  }

function getGoogleRpcReason(details: unknown[] | null | undefined) {
  if (!Array.isArray(details)) {
    return undefined
  }

  for (const detail of details) {
    if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
      continue
    }

    const detailRecord = detail as Record<string, unknown>
    if (typeof detailRecord.reason === 'string') {
      return detailRecord.reason
    }

    const metadata = detailRecord.metadata
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
      continue
    }

    const reason = (metadata as Record<string, unknown>).reason
    if (typeof reason === 'string') {
      return reason
    }
  }

  return undefined
}
