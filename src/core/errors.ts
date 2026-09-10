import {
  ConversationStateConflictError,
  ManualInterventionRequiredError,
  UiAutomationError,
  UiTimeoutError
} from '../runtime/ui-executor.js';
import { UpstreamHttpError, UpstreamRedirectError, UpstreamResponseTooLargeError } from '../runtime/upstream.js';
import { QueueFullError, RequestAbortedError } from '../runtime/serial-queue.js';
import {
  InvalidSessionIdError,
  SessionBusyError,
  SessionLimitExceededError,
  SessionNotSupportedError
} from '../runtime/session-manager.js';
import { ProviderNoImageSupportError, ImageInputError } from '../runtime/multimodal.js';
import { ToolParseFailedError } from '../runtime/tool-response.js';
import { ToolEnforcementError } from '../runtime/tool-enforcement.js';
import { ToolProtocolError } from '../mapping/tool-calling.js';
import {
  InvalidReasoningEffortError,
  ReasoningLevelUnavailableError,
  ReasoningNotSupportedError
} from '../runtime/reasoning.js';

export class InvalidRequestError extends Error {
  readonly status = 400;
  readonly code = 'invalid_request_error';

  constructor(message: string) {
    super(message);
    this.name = 'InvalidRequestError';
  }
}

export interface ProxyErrorDescriptor {
  status: number;
  code: string;
  message: string;
}

export function describeProxyError(error: unknown): ProxyErrorDescriptor {
  const message = error instanceof Error ? error.message : 'Erro interno do proxy.';

  if (error instanceof InvalidRequestError) return { status: error.status, code: error.code, message };
  if (error instanceof RequestAbortedError) return { status: 499, code: 'request_aborted', message };
  if (error instanceof SessionLimitExceededError) return { status: 429, code: 'session_limit_exceeded', message };
  if (error instanceof SessionBusyError) return { status: 409, code: 'session_busy', message };
  if (error instanceof InvalidSessionIdError) return { status: 400, code: 'invalid_session_id', message };
  if (error instanceof SessionNotSupportedError) return { status: 400, code: 'session_not_supported', message };
  if (error instanceof ProviderNoImageSupportError) return { status: 400, code: 'provider_no_image_support', message };
  if (error instanceof ImageInputError) return { status: 400, code: 'image_input_error', message };
  if (error instanceof InvalidReasoningEffortError) return { status: 400, code: 'invalid_reasoning_effort', message };
  if (error instanceof ReasoningNotSupportedError) return { status: 400, code: 'reasoning_not_supported', message };
  if (error instanceof ReasoningLevelUnavailableError) return { status: 400, code: 'reasoning_level_unavailable', message };
  if (error instanceof ToolEnforcementError) return { status: 502, code: 'tool_required_but_not_called', message };
  if (error instanceof ToolParseFailedError) return { status: 502, code: 'tool_parse_failed', message };
  if (error instanceof ToolProtocolError) {
    return error.source === 'request'
      ? { status: 400, code: 'invalid_tool_request', message }
      : { status: 502, code: 'invalid_tool_call', message };
  }
  if (error instanceof ConversationStateConflictError) return { status: 409, code: 'conversation_state_conflict', message };
  if (error instanceof QueueFullError) return { status: 429, code: 'queue_full', message };
  if (error instanceof ManualInterventionRequiredError) return { status: 503, code: 'manual_intervention_required', message };
  if (error instanceof UiTimeoutError) return { status: 504, code: 'ui_timeout', message };
  if (error instanceof UiAutomationError) return { status: 502, code: 'ui_automation_error', message };
  if (error instanceof UpstreamResponseTooLargeError) return { status: 502, code: 'upstream_response_too_large', message };
  if (error instanceof UpstreamRedirectError) return { status: 502, code: 'upstream_redirect_blocked', message };
  if (error instanceof UpstreamHttpError) {
    if (error.status === 429) return { status: 429, code: 'upstream_error', message };
    if (error.status === 401 || error.status === 403) return { status: 502, code: 'upstream_auth_required', message };
    return {
      status: error.status >= 500 ? 502 : 400,
      code: 'upstream_error',
      message
    };
  }

  return { status: 500, code: 'proxy_error', message };
}
