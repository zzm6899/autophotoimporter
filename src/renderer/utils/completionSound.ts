let activeCompleteSound: HTMLAudioElement | null = null;

export function playCompletionSound(soundPath: string): void {
  try {
    if (activeCompleteSound) {
      activeCompleteSound.pause();
      activeCompleteSound.currentTime = 0;
    }

    // File paths need URI encoding; data: URIs must not be re-encoded
    // (encodeURI would corrupt base64 '+' → '%2B', breaking the audio).
    const soundSrc = soundPath
      ? encodeURI(`file:///${soundPath.replace(/\\/g, '/').replace(/^\/+/, '')}`)
      : 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQ4AAACAhIuQlJmbm5qYlJCMiA==';

    const audio = new Audio(soundSrc);
    activeCompleteSound = audio;
    audio.addEventListener('ended', () => {
      if (activeCompleteSound === audio) activeCompleteSound = null;
    }, { once: true });
    void audio.play().catch(() => undefined);
  } catch {
    // Completion audio is optional polish; import success should never depend on it.
  }
}
