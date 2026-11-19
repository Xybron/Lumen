interface ProgramMedia {
  audio: Pick<AudioContext, 'state' | 'currentTime' | 'resume'>;
  close(): void;
}

/** A connected renderer socket is not proof that its audio engine is running.
 * MediaRecorder and the stream muxer both wait for that shared audio clock. */
function waitForAudioClock(audio: ProgramMedia['audio'], timeoutMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const initialTime = audio.currentTime;
    const finish = (error?: Error) => {
      clearInterval(poll); clearTimeout(deadline); signal?.removeEventListener('abort', cancelled);
      if (error) reject(error); else resolve();
    };
    const cancelled = () => finish(new Error('Renderer startup cancelled.'));
    const poll = setInterval(() => {
      if (audio.state === 'running' && audio.currentTime - initialTime >= 0.01) finish();
    }, 25);
    const deadline = setTimeout(() => finish(new Error('The Program audio clock did not start.')), timeoutMs);
    signal?.addEventListener('abort', cancelled, { once: true });
    if (signal?.aborted) { cancelled(); return; }
    // Some Chromium audio startup failures leave resume() pending forever.
    // Observe actual clock progress, with an independent bounded deadline.
    try { void audio.resume().catch(() => {}); } catch { /* The deadline handles unavailable contexts. */ }
  });
}

export async function prepareProgramMedia<T extends ProgramMedia>(create: () => T, options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
  const started = performance.now();
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (options.signal?.aborted) throw new Error('Renderer startup cancelled.');
    const program = create();
    try {
      await waitForAudioClock(program.audio, options.timeoutMs ?? 4000, options.signal);
      if (options.signal?.aborted) throw new Error('Renderer startup cancelled.');
      return { program, attempts: attempt, waitMs: Math.round(performance.now() - started) };
    } catch (error) {
      program.close();
      if (options.signal?.aborted || attempt === 2) throw error;
      // Rebuild only before connecting the renderer or starting any recording,
      // stream or output. An active Program is never restarted for this retry.
    }
  }
  throw new Error('The Program audio clock did not start.');
}
