import type { PresentationGraphics } from '../types';

export type ResolvedPresentationGraphics = PresentationGraphics & Required<Pick<PresentationGraphics,
  'caption' | 'thickness' | 'tip' | 'tipIcon' | 'colorMode' | 'gradientColors'>>;
export const originalFlameStops = [
  [0, '#4a0a05'], [.18, '#7a1a08'], [.38, '#c8350c'], [.6, '#ff6a14'],
  [.8, '#ffb43c'], [.94, '#ffe9a3'], [1, '#ffffff'],
] as const;
export const defaultPresentationGraphics: ResolvedPresentationGraphics = {
  template: 'flame', progress: true, timer: true, countdown: true, warning: false, caption: false,
  timerMode: 'remaining', position: 'top', size: 'medium', color: '#ff8b32',
  thickness: 5, tip: 'glow', tipIcon: 'flame', colorMode: 'original',
  gradientColors: ['#4a0a05', '#ff6a14', '#ffffff'],
};
export function presentationGraphics(value?: Partial<PresentationGraphics>): ResolvedPresentationGraphics {
  // Legacy configured graphics keep their layout and colours. Only an unset
  // presentation gets the restored flame default; reading never rewrites data.
  const legacy = !!value && value.template !== undefined && value.template !== 'flame';
  const template = value?.template ?? 'flame';
  const result = { ...defaultPresentationGraphics, ...(legacy ? {
    position: 'bottom' as const, color: '#7dd3fc', caption: value.timer ?? true,
    thickness: template === 'minimal' ? 5 : template === 'segments' ? 12 : 8,
    tip: 'none' as const, colorMode: template === 'ember' ? 'gradient' as const : 'solid' as const,
    gradientColors: template === 'ember' ? ['#6a150b', value.color ?? '#7dd3fc', '#fff1cd'] : [...defaultPresentationGraphics.gradientColors],
  } : {}), ...value };
  result.gradientColors = [...(value?.gradientColors ?? result.gradientColors)];
  return result;
}
export function presentationTemplateDefaults(template: PresentationGraphics['template']) {
  const defaults = template === 'flame' ? presentationGraphics() : presentationGraphics({ template });
  return { template, position: defaults.position, thickness: defaults.thickness, tip: defaults.tip,
    colorMode: defaults.colorMode, color: template === 'ember' ? '#ff8b32' : defaults.color,
    gradientColors: template === 'ember' ? ['#6a150b', '#ff8b32', '#fff1cd'] : defaults.gradientColors };
}
export interface PresentationGraphicsFrame {
  graphics: PresentationGraphics;
  elapsedMs: number;
  durationMs: number;
  countdownAtMs: number;
  warningAtMs: number;
  title?: string;
}
export interface PresentationClock { elapsedMs: number; receivedAt: number }
export function presentationElapsed(clock: PresentationClock | undefined, durationMs: number, playing: boolean, now: number): number {
  if (!clock || !Number.isFinite(durationMs) || durationMs <= 0) return 0;
  return Math.max(0, Math.min(durationMs, clock.elapsedMs + (playing ? Math.max(0, now - clock.receivedAt) : 0)));
}
export function presentationTime(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60);
  return hours ? `${hours}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function barPaint(ctx: CanvasRenderingContext2D, g: ResolvedPresentationGraphics, x: number, filled: number): string | CanvasGradient {
  if (g.colorMode === 'solid') return g.color;
  const gradient = ctx.createLinearGradient(x, 0, x + Math.max(1, filled), 0);
  if (g.colorMode === 'original') originalFlameStops.forEach(([at, color]) => gradient.addColorStop(at, color));
  else {
    const colors = g.gradientColors.length >= 2 ? g.gradientColors : [g.color, '#ffffff'];
    colors.forEach((color, index) => gradient.addColorStop(index / (colors.length - 1), color));
  }
  return gradient;
}
function iconPath(ctx: CanvasRenderingContext2D, icon: ResolvedPresentationGraphics['tipIcon']) {
  ctx.beginPath();
  if (icon === 'star') {
    for (let i = 0; i < 10; i++) {
      const angle = -Math.PI / 2 + i * Math.PI / 5, radius = i % 2 ? .43 : 1;
      const x = Math.cos(angle) * radius, y = Math.sin(angle) * radius;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  } else if (icon === 'diamond') { ctx.moveTo(0, -1); ctx.lineTo(.75, 0); ctx.lineTo(0, 1); ctx.lineTo(-.75, 0); }
  else if (icon === 'cross') {
    ctx.moveTo(-.22, -1); ctx.lineTo(.22, -1); ctx.lineTo(.22, -.4); ctx.lineTo(.72, -.4); ctx.lineTo(.72, .03);
    ctx.lineTo(.22, .03); ctx.lineTo(.22, 1); ctx.lineTo(-.22, 1); ctx.lineTo(-.22, .03); ctx.lineTo(-.72, .03); ctx.lineTo(-.72, -.4); ctx.lineTo(-.22, -.4);
  } else if (icon === 'heart') {
    ctx.moveTo(0, .95); ctx.bezierCurveTo(-1.8, -.1, -.7, -1.55, 0, -.65); ctx.bezierCurveTo(.7, -1.55, 1.8, -.1, 0, .95);
  } else {
    ctx.moveTo(0, -1); ctx.bezierCurveTo(.15, -.2, 1.15, -.1, .65, .65); ctx.bezierCurveTo(.25, 1.2, -.8, 1.1, -.75, .35);
    ctx.bezierCurveTo(-.7, -.15, -.3, -.25, -.35, -.75); ctx.bezierCurveTo(-.2, -.6, -.1, -.4, 0, -1);
  }
  ctx.closePath();
}
function drawTip(ctx: CanvasRenderingContext2D, g: ResolvedPresentationGraphics, x: number, y: number, scale: number) {
  if (g.tip === 'none') return;
  ctx.save(); ctx.translate(x, y);
  if (g.tip === 'glow') {
    const radius = 7 * scale, tip = ctx.createRadialGradient(0, 0, 0, 0, 0, radius);
    tip.addColorStop(0, '#ffffff'); tip.addColorStop(.35, g.colorMode === 'original' ? '#ffe28a' : '#ffffff');
    tip.addColorStop(.7, g.colorMode === 'original' ? '#ff9a30' : g.color); tip.addColorStop(1, 'rgba(255,90,20,0)');
    ctx.fillStyle = tip;
    for (const [blur, color] of [[14, 'rgba(255,80,20,.6)'], [7, 'rgba(255,200,80,.9)']] as const) {
      ctx.shadowBlur = blur * scale; ctx.shadowColor = g.colorMode === 'original' ? color : g.color;
      ctx.beginPath(); ctx.arc(0, 0, radius, 0, Math.PI * 2); ctx.fill();
    }
  } else if (g.tip === 'plain') {
    ctx.fillStyle = g.color; ctx.beginPath(); ctx.arc(0, 0, 7 * scale, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.scale(12 * scale, 12 * scale); iconPath(ctx, g.tipIcon); ctx.fillStyle = g.color;
    ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = .12; ctx.stroke(); ctx.fill();
  }
  ctx.restore();
}

/** The same painter feeds Program, standalone outputs and the draft inspector. */
export function drawPresentationGraphics(ctx: CanvasRenderingContext2D, frame: PresentationGraphicsFrame, width: number, height: number) {
  if (width <= 0 || height <= 0) return;
  const g = presentationGraphics(frame.graphics);
  const timed = Number.isFinite(frame.durationMs) && frame.durationMs > 0;
  if (!timed) { g.progress = false; g.timer = false; g.countdown = false; g.warning = false; }
  const elapsed = timed ? Math.min(frame.durationMs, Math.max(0, frame.elapsedMs)) : 0;
  const remaining = timed ? Math.max(0, frame.durationMs - elapsed) : 0, progress = timed ? elapsed / frame.durationMs : 0;
  const scale = ({ small: .75, medium: 1, large: 1.35 })[g.size];
  const flame = g.template === 'flame';
  const showTimer = g.timer && !flame;
  const margin = 46, hasText = showTimer || g.caption;
  const panelHeight = (hasText ? 82 : 42) * scale;
  // The original flame keeps only its optional caption in the safe area.
  // Its progress and countdown cues do not need a persistent footer timer.
  const panelY = flame ? 1080 - margin - panelHeight : g.position === 'bottom' ? 1080 - margin - panelHeight : margin;
  const x = margin, w = 1920 - margin * 2, inset = g.template === 'broadcast' ? 24 * scale : 0;
  const textY = panelY + 27 * scale;
  const barHeight = Math.max(2, Math.min(24, g.thickness)) * scale;
  const barX = flame ? 0 : x + inset, barWidth = flame ? 1920 : w - inset * 2;
  const barY = flame ? g.position === 'top' ? 0 : 1080 - barHeight : panelY + (hasText ? 62 : 17) * scale;
  ctx.save(); ctx.scale(width / 1920, height / 1080);
  ctx.shadowBlur = 0; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  if ((hasText || g.progress) && g.template === 'broadcast') {
    ctx.fillStyle = 'rgba(8,16,24,.88)'; ctx.beginPath(); ctx.roundRect(x, panelY, w, panelHeight, 12 * scale); ctx.fill();
  }
  if (hasText) {
    ctx.font = `500 ${28 * scale}px Inter, system-ui, sans-serif`;
    ctx.shadowColor = '#000000'; ctx.shadowBlur = 6 * scale; ctx.fillStyle = '#ffffff';
    const timer = showTimer ? `${presentationTime(g.timerMode === 'elapsed' ? elapsed : remaining)} ${g.timerMode}` : '';
    ctx.textAlign = 'right'; if (timer) ctx.fillText(timer, x + w - inset, textY);
    const timerWidth = timer ? ctx.measureText(timer).width + 80 * scale : 0;
    let title = g.caption ? frame.title?.replace(/\s+/g, ' ').trim() ?? '' : '';
    const available = w - inset * 2 - timerWidth;
    if (ctx.measureText(title).width > available) {
      while (title.length && ctx.measureText(`${title}…`).width > available) title = title.slice(0, -1);
      title += '…';
    }
    ctx.textAlign = 'left'; if (title) ctx.fillText(title, x + inset, textY);
    ctx.shadowBlur = 0;
  }
  if (g.progress) {
    const filled = barWidth * progress;
    if (g.template === 'segments') {
      const count = 24, gap = 8 * scale, segment = (barWidth - gap * (count - 1)) / count;
      const fill = barPaint(ctx, g, barX, filled);
      for (let i = 0; i < count; i++) {
        ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fillRect(barX + i * (segment + gap), barY, segment, barHeight);
        ctx.fillStyle = fill; ctx.fillRect(barX + i * (segment + gap), barY, segment * Math.max(0, Math.min(1, progress * count - i)), barHeight);
      }
    } else {
      if (!flame) { ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fillRect(barX, barY, barWidth, barHeight); }
      ctx.fillStyle = barPaint(ctx, g, barX, filled);
      if (g.tip === 'glow' || flame && g.colorMode === 'original') {
        for (const [blur, color] of [[18, 'rgba(255,80,20,.4)'], [8, 'rgba(255,120,30,.6)']] as const) {
          ctx.shadowBlur = blur * scale; ctx.shadowColor = g.colorMode === 'original' ? color : g.color;
          ctx.fillRect(barX, barY, filled, barHeight);
        }
      } else {
        if (g.template === 'ember') { ctx.shadowBlur = 18 * scale; ctx.shadowColor = g.color; }
        ctx.fillRect(barX, barY, filled, barHeight);
      }
      ctx.shadowBlur = 0;
    }
    const tipX = g.tip === 'icon' ? Math.max(14 * scale, Math.min(1920 - 14 * scale, barX + filled)) : barX + filled;
    const tipY = g.tip === 'icon' ? Math.max(14 * scale, Math.min(1080 - 14 * scale, barY + barHeight / 2)) : barY + barHeight / 2;
    drawTip(ctx, g, tipX, tipY, scale);
  }
  const countdown = g.countdown && elapsed > 0 && remaining > 0 && remaining <= frame.countdownAtMs;
  const warning = g.warning && elapsed > 0 && remaining > frame.countdownAtMs && remaining <= frame.warningAtMs;
  if (countdown || warning) {
    const y = !flame && g.position === 'top' && (hasText || g.progress) ? panelY + panelHeight + 64 * scale : 88 * scale;
    ctx.fillStyle = 'rgba(8,16,24,.9)'; ctx.strokeStyle = g.color; ctx.lineWidth = 4 * scale;
    if (countdown) {
      const cx = 1920 - margin - 45 * scale, r = 44 * scale;
      ctx.beginPath(); ctx.arc(cx, y, r, 0, Math.PI * 2); ctx.fill();
      ctx.beginPath(); ctx.arc(cx, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * remaining / Math.max(1, frame.countdownAtMs)); ctx.stroke();
      ctx.fillStyle = '#ffffff'; ctx.font = `600 ${38 * scale}px Inter, system-ui, sans-serif`; ctx.textAlign = 'center'; ctx.fillText(String(Math.ceil(remaining / 1000)), cx, y);
    } else {
      ctx.font = `500 ${26 * scale}px Inter, system-ui, sans-serif`;
      const label = `${presentationTime(remaining)} remaining`, boxWidth = ctx.measureText(label).width + 44 * scale;
      ctx.beginPath(); ctx.roundRect(1920 - margin - boxWidth, y - 28 * scale, boxWidth, 56 * scale, 12 * scale); ctx.fill();
      ctx.fillStyle = '#ffffff'; ctx.textAlign = 'right'; ctx.fillText(label, 1920 - margin - 22 * scale, y);
    }
  }
  ctx.restore();
}
