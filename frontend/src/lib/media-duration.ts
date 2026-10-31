/** Read a station video clip's duration without loading the whole file. */
export function probeVideoDurationMs(url: string): Promise<number | null> {
  return new Promise(resolve => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.muted = true;
    let settled = false;
    const finish = (duration: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      video.removeEventListener('loadedmetadata', loaded);
      video.removeEventListener('error', failed);
      video.removeAttribute('src');
      video.load();
      resolve(duration);
    };
    const loaded = () => finish(Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 1000) : null);
    const failed = () => finish(null);
    const timeout = window.setTimeout(failed, 10000);
    video.addEventListener('loadedmetadata', loaded);
    video.addEventListener('error', failed);
    video.src = url;
  });
}
