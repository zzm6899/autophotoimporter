let activeCompleteSound: HTMLAudioElement | null = null;

export function playCompletionSound(soundPath: string): void {
  try {
    if (activeCompleteSound) {
      activeCompleteSound.pause();
      activeCompleteSound.currentTime = 0;
    }

    const soundSrc = soundPath
      ? `file:///${soundPath.replace(/\\/g, '/').replace(/^\/+/, '')}`
      : 'data:audio/wav;base64,UklGRjIAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQ4AAACAhIuQlJmbm5qYlJCMiA==';

    const audio = new Audio(encodeURI(soundSrc));
    activeCompleteSound = audio;
    audio.addEventListener('ended', () => {
      if (activeCompleteSound === audio) activeCompleteSound = null;
    }, { once: true });
    void audio.play().catch(() => undefined);
  } catch {
    // Completion audio is optional polish; import success should never depend on it.
  }
}
