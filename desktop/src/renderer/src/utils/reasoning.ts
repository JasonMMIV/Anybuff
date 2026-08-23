import modelReasoningMap from './anybuff-models.json'

export function getReasoningOptionsForModel(modelId: string | undefined): string[] {
  if (!modelId) return ['default']
  const bareModel = modelId.split('/').pop() || ''
  
  let opts: string[] = []
  if (bareModel in modelReasoningMap) {
    opts = (modelReasoningMap as Record<string, string[]>)[bareModel]
  }

  // If the map gave us options other than just ['default'] or [], use them!
  if (opts.length > 1 || (opts.length === 1 && opts[0] !== 'default')) {
    const normalizedOpts = opts.map(o => o === 'xhigh' ? 'extra-high' : o)
    if (!normalizedOpts.includes('default')) {
      normalizedOpts.unshift('default')
    }
    return normalizedOpts
  }

  // General fallback for unknown models.
  // OmniChat handles unknown reasoning models by providing standard effort levels (Auto, Light, Medium, Heavy),
  // and relies on API capabilities or manual UI toggles to enable the reasoning feature.
  // Since AnyBuff doesn't currently parse API capabilities or have a manual toggle,
  // we provide the standard options to ensure users can configure effort for new reasoning models.
  return ['default', 'low', 'medium', 'high']
}
