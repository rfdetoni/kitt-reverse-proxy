/** KAP wire negotiation is transport metadata, never model authority. */
export const KAP_VERSION_HEADER = 'X-Kitt-KAP' as const;
export const KAP_CURRENT_VERSION = 'KAP/2' as const;
export const KAP_SUPPORTED_VERSIONS = [KAP_CURRENT_VERSION] as const;

export class KAPNegotiationError extends Error {
  constructor() { super('Unsupported KAP version; expected KAP/2'); this.name = 'KAPNegotiationError'; }
}

/** Missing metadata keeps old KAP/2 clients working, unknown versions fail closed. */
export function negotiateKAPVersion(requested: string | undefined): typeof KAP_CURRENT_VERSION {
  if (requested !== undefined && requested !== KAP_CURRENT_VERSION) throw new KAPNegotiationError();
  return KAP_CURRENT_VERSION;
}
