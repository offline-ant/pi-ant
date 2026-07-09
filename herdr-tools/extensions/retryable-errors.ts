const RETRYABLE_ASSISTANT_ERROR_PATTERN =
  /overloaded|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|connection.?error|connection.?refused|websocket|other side closed|fetch failed|upstream.?connect|reset before headers|terminated|retry delay/i;

// Extensions currently do not receive agent_end.willRetry. On retryable failures,
// wait for a new agent_start before deciding the retry chain is exhausted.
export const RETRY_START_GRACE_MS = 60_000;

export function isRetryableAssistantErrorMessage(errorMessage: string | undefined): boolean {
  return typeof errorMessage === "string" && RETRYABLE_ASSISTANT_ERROR_PATTERN.test(errorMessage);
}
