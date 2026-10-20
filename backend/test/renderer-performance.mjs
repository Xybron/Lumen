// Generated-frame comparison only: no station, sources, credentials or network.
import { chromium } from 'playwright-core';

const executablePath = process.env.LUMEN_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
for (const accelerated of [false, true]) {
  const browser = await chromium.launch({ executablePath, headless: true, args: ['--autoplay-policy=no-user-gesture-required', ...(accelerated ? ['--enable-gpu'] : [])] });
  try {
    const cdp = await browser.newBrowserCDPSession();
    const info = await cdp.send('SystemInfo.getInfo');
    const page = await browser.newPage();
    await page.setContent('<canvas width="1920" height="1080"></canvas>');
    await page.evaluate(() => {
      const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d', { alpha: false });
      const artwork = document.createElement('canvas'); artwork.width = 1920; artwork.height = 1080;
      const art = artwork.getContext('2d');
      const gradient = art.createLinearGradient(0, 0, 1920, 1080); gradient.addColorStop(0, '#d4a65a'); gradient.addColorStop(1, '#172934'); art.fillStyle = gradient; art.fillRect(0, 0, 1920, 1080);
      art.font = '70px sans-serif'; art.fillStyle = 'white'; art.fillText('Generated production artwork', 120, 300);
      const outputs = [0, 1, 2].map(() => { const out = document.createElement('canvas'); out.width = 1920; out.height = 1080; return out.getContext('2d', { alpha: false }); });
      window.benchmarkFrames = 0;
      window.benchmarkTimer = setInterval(() => {
        ctx.drawImage(artwork, 0, 0);
        for (let index = 0; index < 6; index++) { ctx.fillStyle = '#ffffff12'; ctx.fillRect(index * 180, 600, 150, 120); }
        for (const output of outputs) output.drawImage(canvas, 0, 0);
        window.benchmarkFrames++;
      }, 1000 / 30);
      const stream = canvas.captureStream(30);
      window.benchmarkRecorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 6000000 });
      window.benchmarkRecorder.ondataavailable = () => {};
      window.benchmarkRecorder.start(500);
    });
    await new Promise(resolve => setTimeout(resolve, 1200));
    const before = await cdp.send('SystemInfo.getProcessInfo'), start = performance.now();
    const framesBefore = await page.evaluate(() => window.benchmarkFrames);
    await new Promise(resolve => setTimeout(resolve, 4000));
    const after = await cdp.send('SystemInfo.getProcessInfo'), seconds = (performance.now() - start) / 1000;
    const cpuBefore = new Map(before.processInfo.map(item => [item.id, item.cpuTime]));
    const cpuSeconds = after.processInfo.reduce((sum, item) => sum + Math.max(0, item.cpuTime - (cpuBefore.get(item.id) ?? item.cpuTime)), 0);
    console.log(JSON.stringify({ accelerated, cpuPercent: Math.round(cpuSeconds / seconds * 100), fps: (await page.evaluate(() => window.benchmarkFrames) - framesBefore) / seconds, gpu: info.gpu.featureStatus, devices: info.gpu.devices.map(device => device.deviceString) }));
  } finally { await browser.close(); }
}
