import type { AdapterProfile, AppConfig, CapturedExchange } from '../types.js';
import { logger } from '../logger.js';
import { DeclarativeAdapter } from './engine.js';
import { createFallbackProfile } from './fallback.js';
import { generateProfile } from './ollama.js';
import { loadProfile, saveProfile, validateProfile } from './profile.js';

function ensureProfileMatchesTarget(profile: AdapterProfile, capture: CapturedExchange): void {
  if (profile.metadata?.targetHost && profile.metadata.targetHost !== new URL(capture.endpointUrl).hostname) {
    throw new Error(`Profile pertence a ${profile.metadata.targetHost}, mas endpoint detectado é ${new URL(capture.endpointUrl).hostname}.`);
  }
}

export async function createAdapter(capture: CapturedExchange, config: AppConfig): Promise<{ adapter: DeclarativeAdapter; profile: AdapterProfile; source: string }> {
  let profile: AdapterProfile;
  let source: string;

  if (config.profilePath) {
    profile = validateProfile(await loadProfile(config.profilePath));
    ensureProfileMatchesTarget(profile, capture);
    source = 'profile-file';
  } else {
    try {
      profile = await generateProfile(capture, config);
      profile = validateProfile({
        ...profile,
        metadata: {
          ...profile.metadata,
          targetHost: new URL(capture.endpointUrl).hostname,
          endpointPath: new URL(capture.endpointUrl).pathname,
          generatedBy: `ollama:${config.model}`
        }
      });
      source = 'ollama';
    } catch (error) {
      logger.warn(`Profile via Ollama falhou: ${error instanceof Error ? error.message : String(error)}`);
      logger.warn('Ativando profile heurístico determinístico.');
      profile = createFallbackProfile(capture.requestSample, capture.responseSample, capture.endpointUrl);
      source = 'fallback';
    }
  }

  let adapter = new DeclarativeAdapter(profile, capture.requestSample, config.model);
  try {
    adapter.validate();
    if (capture.responseSample != null) adapter.mapResponse(capture.responseSample, 'probe-model');
  } catch (error) {
    if (source === 'fallback' || config.profilePath) throw error;
    logger.warn(`Profile aprendido não passou no probe: ${error instanceof Error ? error.message : String(error)}`);
    profile = createFallbackProfile(capture.requestSample, capture.responseSample, capture.endpointUrl);
    source = 'fallback';
    adapter = new DeclarativeAdapter(profile, capture.requestSample, config.model);
    adapter.validate();
  }

  if (config.saveProfilePath) {
    await saveProfile(config.saveProfilePath, profile);
    logger.success(`Profile salvo em ${config.saveProfilePath} (sem cookies/headers).`);
  }
  return { adapter, profile, source };
}
