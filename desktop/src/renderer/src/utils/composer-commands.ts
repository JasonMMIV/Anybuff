/**
 * Built-in slash commands offered by the composer. Extracted from Composer so
 * the list (notably the `/compact` entry) is unit-testable.
 */
export interface SlashCommand {
  id: string
  label: string
  description: string
}

export const SLASH_COMMANDS: SlashCommand[] = [
  {
    id: 'init',
    label: 'init',
    description:
      'Analyze the project and create/update knowledge.md (project long-term memory)',
  },
  {
    id: 'review',
    label: 'review',
    description: 'Structured code review with scope presets',
  },
  {
    id: 'interview',
    label: 'interview',
    description: 'Interrogate your request into a detailed spec',
  },
  {
    id: 'compact',
    label: 'compact',
    description:
      'Summarize earlier messages to free context (the transcript stays visible)',
  },
]
