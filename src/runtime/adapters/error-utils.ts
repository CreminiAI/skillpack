const OPENAI_RESPONSES_ERROR_PREFIX = /OpenAI API error \(\d+\):\s*/;

export function sanitizeAdapterErrorMessage(message: string): string {
  return message.replace(OPENAI_RESPONSES_ERROR_PREFIX, "");
}
