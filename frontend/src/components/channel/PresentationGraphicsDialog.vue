<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import { toast } from 'vue-sonner';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { SlidersHorizontal, Sparkles, Check, Palette, Timer, Bookmark, Plus, Minus, Monitor, Flame, MoveHorizontal, Trash2 } from 'lucide-vue-next';
import GraphicsChoicePreview from './GraphicsChoicePreview.vue';
import { useContentStore } from '@/stores/content';
import { useIdentityStore } from '@/stores/identity';
import { usePresenceStore } from '@/stores/presence';
import { usePlaybackStore } from '@/stores/playback';
import { drawPresentationGraphics, originalFlameStops, presentationGraphics, presentationTime, presentationTemplateDefaults } from '@/lib/presentation-graphics';
import { computePrayerLabels } from '@/lib/prayers';
import { useEnginesStore } from '@/stores/engines';
import { drawPresentationItem } from '@/lib/studio/compositor';
import { mediaAssetUrl } from '@/lib/studio/media-library';
import type { SceneSourceBank } from '@/lib/studio/sources';
import type { Channel, PresentationGraphics } from '@/types';
const props = defineProps<{ open: boolean; channel: Channel }>();
const emit = defineEmits<{ (e: 'update:open', value: boolean): void }>();
const content = useContentStore(), identity = useIdentityStore(), presence = usePresenceStore(), playback = usePlaybackStore();
const engines = useEnginesStore();
const draft = reactive(presentationGraphics()), presets = ref<NonNullable<Channel['presentationGraphicPresets']>>([]);
const presetName = ref(''), selectedPreset = ref(''), saving = ref(false), previewPercent = ref(65);
const canvas = ref<HTMLCanvasElement>();
const templates = [
  { value: 'flame', label: 'Original flame', detail: 'The familiar glow, right at the edge.' },
  { value: 'minimal', label: 'Minimal line', detail: 'Quiet and understated.' },
  { value: 'broadcast', label: 'Broadcast lower third', detail: 'A framed strip for your graphics.' },
  { value: 'segments', label: 'Segmented progress', detail: 'Mark each step along the way.' },
  { value: 'ember', label: 'Ember glow', detail: 'A warm, softly glowing line.' },
] as const;
const tips = [{ value: 'glow', label: 'Original glow' }, { value: 'plain', label: 'Plain dot' }, { value: 'icon', label: 'Icon' }, { value: 'none', label: 'None' }] as const;
const icons = [{ value: 'flame', label: 'Flame' }, { value: 'star', label: 'Star' }, { value: 'cross', label: 'Cross' }, { value: 'diamond', label: 'Diamond' }, { value: 'heart', label: 'Heart' }] as const;
const palette = [{ color: '#ff8b32', name: 'Amber' }, { color: '#f87171', name: 'Coral' }, { color: '#fbbf24', name: 'Gold' }, { color: '#34d399', name: 'Mint' }, { color: '#7dd3fc', name: 'Sky' }, { color: '#a78bfa', name: 'Violet' }, { color: '#f472b6', name: 'Rose' }, { color: '#ffffff', name: 'White' }];
const gradients = [
  { name: 'Flame', colors: ['#4a0a05', '#ff6a14', '#ffffff'] },
  { name: 'Sunset', colors: ['#6d28d9', '#ec4899', '#fb923c'] },
  { name: 'Ocean', colors: ['#153f76', '#22d3ee', '#c7f9ff'] },
  { name: 'Emerald', colors: ['#064e3b', '#34d399', '#ecfdf5'] },
  { name: 'Royal', colors: ['#312e81', '#a78bfa', '#f5f3ff'] },
  { name: 'Sunrise', colors: ['#a21caf', '#f97316', '#fde68a'] },
];
const spectrum = `linear-gradient(90deg, ${originalFlameStops.map(([at, color]) => `${color} ${at * 100}%`).join(', ')})`;
const gradientCss = (colors: readonly string[]) => `linear-gradient(90deg, ${colors.join(', ')})`;
const activeGradient = computed(() => gradientCss(draft.gradientColors));
const styleLabel = computed(() => templates.find(t => t.value === draft.template)?.label);
const countdownPosition = computed(() => Math.max(0, Math.min(99, (1 - Math.min(5000, content.content.settings.countdownAtMs / 2) / Math.max(1, duration.value)) * 100)));
const details = [
  { key: 'timer', label: 'Timer', detail: 'Show remaining or elapsed time.' },
  { key: 'countdown', label: 'Final countdown', detail: 'Count down the final seconds.' },
  { key: 'warning', label: 'Time warning', detail: 'Give the audience an early cue.' },
  { key: 'caption', label: 'Slide caption', detail: 'Keep the slide title on screen.' },
] as const;
const currentChannel = computed(() => content.channels.find(c => c.id === props.channel.id));
const canEdit = computed(() => !!currentChannel.value && identity.can(props.channel.id, 'author') && !presence.controlledByOther(props.channel.id));
const playlist = computed(() => content.playlistForChannel(props.channel.id));
const item = computed(() => engines.focusedChannelId === props.channel.id ? playback.current ?? playlist.value?.items[0] : playlist.value?.items[0]);
const renderContext = computed(() => ({ prayerLabel: item.value ? computePrayerLabels(playlist.value?.items ?? [])[item.value.id]?.display : undefined }));
const duration = computed(() => item.value?.durationMs || content.content.settings.defaultDurationMs);
const elapsed = computed(() => Math.round(duration.value * previewPercent.value / 100));
const previewLabel = computed(() => `${presentationTime(elapsed.value)} / ${presentationTime(duration.value)}`);
const images = new Map<string, HTMLImageElement>();
const bank: SceneSourceBank = { inputs: new Map(), channelItem: () => undefined, isTextChannel: () => false,
  image(url) { let image = images.get(url); if (!image) { image = new Image(); image.src = mediaAssetUrl(url) || url; images.set(url, image); } return image; } };
let raf = 0, video: HTMLVideoElement | null = null, videoUrl = '';
function stop() { cancelAnimationFrame(raf); if (video) { video.pause(); video.removeAttribute('src'); video.load(); } video = null; videoUrl = ''; images.clear(); }
function paint() {
  const ctx = canvas.value?.getContext('2d', { alpha: false });
  if (ctx) {
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#101820'; ctx.fillRect(0, 0, 960, 540);
    ctx.save(); ctx.scale(.5, .5);
    const current = item.value, url = current?.background?.kind === 'video' ? current.background.src ?? '' : '';
    if (url !== videoUrl) {
      if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
      video = null; videoUrl = url;
      if (url) { video = document.createElement('video'); video.muted = true; video.preload = 'auto'; video.playsInline = true; video.src = mediaAssetUrl(url) || url; video.load(); }
    }
    if (current) drawPresentationItem(ctx, current, bank, video, 1920, 1080, renderContext.value);
    drawPresentationGraphics(ctx, { graphics: draft, durationMs: duration.value, elapsedMs: elapsed.value,
      countdownAtMs: content.content.settings.countdownAtMs, warningAtMs: content.content.settings.warningAtMs,
      title: current?.title || props.channel.name }, 1920, 1080);
    ctx.restore();
  }
  raf = requestAnimationFrame(paint);
}
watch(() => [props.open, props.channel.id] as const, ([open]) => {
  stop();
  if (open) {
    Object.assign(draft, presentationGraphics(props.channel.presentationGraphics));
    presets.value = JSON.parse(JSON.stringify(props.channel.presentationGraphicPresets ?? []));
    presetName.value = ''; selectedPreset.value = ''; previewPercent.value = 65;
    raf = requestAnimationFrame(paint);
  }
}, { immediate: true });
onBeforeUnmount(stop);
function chooseTemplate(value: PresentationGraphics['template']) { Object.assign(draft, presentationTemplateDefaults(value)); }
function templatePreview(value: PresentationGraphics['template']) { return { ...draft, ...presentationTemplateDefaults(value) }; }
function chooseGradient(colors: string[]) { draft.colorMode = 'gradient'; draft.gradientColors = [...colors]; }
function loadPreset() { const value = presets.value.find(p => p.name === selectedPreset.value); if (value) Object.assign(draft, presentationGraphics(value.graphics)); }
function savePreset() {
  const name = presetName.value.trim();
  if (!name || name.length > 48) return;
  const existing = presets.value.findIndex(p => p.name === name), value = { name, graphics: { ...draft, gradientColors: [...draft.gradientColors] } };
  if (existing >= 0) presets.value[existing] = value;
  else if (presets.value.length < 20) presets.value.push(value);
  else { toast.error('You can save up to 20 graphics presets per presentation.'); return; }
  selectedPreset.value = name; presetName.value = '';
}
async function apply() {
  if (!canEdit.value || saving.value) return;
  const channelId = props.channel.id, graphics: PresentationGraphics = { ...draft, gradientColors: [...draft.gradientColors] };
  const savedPresets = JSON.parse(JSON.stringify(presets.value));
  saving.value = true;
  try {
    const saved = await content.save(value => {
      const channel = value.channels.find(c => c.id === channelId);
      if (!channel || !identity.can(channelId, 'author') || presence.controlledByOther(channelId)) throw new Error('Presentation control changed.');
      channel.presentationGraphics = graphics; channel.presentationGraphicPresets = savedPresets;
    });
    if (saved) { toast.success('Presentation graphics applied to Program and display outputs.'); emit('update:open', false); }
  } catch (error) { toast.error(error instanceof Error ? error.message : 'Graphics could not be saved.'); }
  finally { saving.value = false; }
}
</script>
<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="graphics-dialog">
      <DialogHeader class="graphics-header">
        <div class="graphics-heading-icon"><SlidersHorizontal :size="20" /></div>
        <div><DialogTitle class="graphics-title">Presentation graphics</DialogTitle><DialogDescription class="graphics-description">{{ channel.name }} · Design the details your audience sees.</DialogDescription></div>
      </DialogHeader>
      <div class="graphics-layout">
        <div class="graphics-controls" tabindex="0" role="region" aria-label="Graphics settings">
          <section class="graphics-section" aria-labelledby="graphics-style-heading">
            <div class="graphics-section-heading"><Sparkles :size="15" /><h3 id="graphics-style-heading">Progress style</h3><span>Choose a starting point</span></div>
            <div class="graphics-templates" role="group" aria-label="Graphics template">
              <button v-for="template in templates" :key="template.value" type="button" class="graphics-style-card" :class="{ 'graphics-original': template.value === 'flame' }" :aria-label="template.label" :aria-pressed="draft.template === template.value" @click="chooseTemplate(template.value)">
                <div class="graphics-style-sample"><GraphicsChoicePreview :graphics="templatePreview(template.value)" kind="template" :value="template.value" /></div>
                <span class="graphics-card-label">{{ template.label }}<span v-if="template.value === 'flame'" class="graphics-default">Original</span><Check v-if="draft.template === template.value" :size="13" /></span>
                <span class="graphics-card-detail">{{ template.detail }}</span>
              </button>
            </div>
          </section>

          <section class="graphics-section" aria-labelledby="graphics-bar-heading">
            <div class="graphics-section-heading"><MoveHorizontal :size="15" /><h3 id="graphics-bar-heading">Progress bar</h3><label class="graphics-switch graphics-heading-switch"><input v-model="draft.progress" type="checkbox" aria-label="Progress bar" /><span aria-hidden="true" /></label></div>
            <template v-if="draft.progress">
              <div class="graphics-field"><span class="graphics-label">Position</span><div class="graphics-position-options" role="group" aria-label="Progress position"><button v-for="position in (['top', 'bottom'] as const)" :key="position" type="button" :aria-label="position === 'top' ? 'Top' : 'Bottom'" :aria-pressed="draft.position === position" @click="draft.position = position"><span class="graphics-position-mini" :class="`at-${position}`" aria-hidden="true"><i /><b /><b /></span><span>{{ position === 'top' ? 'Top' : 'Bottom' }}</span><Check v-if="draft.position === position" :size="12" /></button></div></div>
              <div class="graphics-field"><label class="graphics-field-row" for="graphics-thickness"><span class="graphics-label">Thickness</span><span class="graphics-value">{{ draft.thickness }}<small>px</small></span></label><input id="graphics-thickness" v-model.number="draft.thickness" type="range" min="2" max="24" step="1" aria-label="Progress thickness" /></div>
              <div class="graphics-field"><span class="graphics-label">Leading tip<span class="graphics-muted">The finishing touch</span></span><div class="graphics-tip-options" role="group" aria-label="Progress tip"><button v-for="tip in tips" :key="tip.value" type="button" class="graphics-mini-card" :aria-label="tip.label" :aria-pressed="draft.tip === tip.value" @click="draft.tip = tip.value"><span class="graphics-tip-sample"><GraphicsChoicePreview :graphics="{ ...draft, tip: tip.value }" kind="tip" :value="tip.value" /></span><span>{{ tip.label }}</span><Check v-if="draft.tip === tip.value" :size="11" class="graphics-mini-check" /></button></div></div>
              <div v-if="draft.tip === 'icon'" class="graphics-field"><span class="graphics-label">Tip icon</span><div class="graphics-icon-options" role="group" aria-label="Progress tip icon"><button v-for="icon in icons" :key="icon.value" type="button" class="graphics-mini-card" :aria-label="icon.label" :aria-pressed="draft.tipIcon === icon.value" @click="draft.tipIcon = icon.value"><span class="graphics-icon-sample"><GraphicsChoicePreview :graphics="{ ...draft, tip: 'icon', tipIcon: icon.value }" kind="icon" :value="icon.value" /></span><span>{{ icon.label }}</span></button></div></div>
            </template>
            <p v-else class="graphics-help">The progress bar is hidden from your audience. Your operator timer stays available.</p>
          </section>

          <section class="graphics-section" aria-labelledby="graphics-colour-heading">
            <div class="graphics-section-heading"><Palette :size="15" /><h3 id="graphics-colour-heading">Colour &amp; gradient</h3></div>
            <div class="graphics-colour-modes" role="group" aria-label="Progress colour style">
              <button type="button" class="graphics-colour-mode" aria-label="Original spectrum" :aria-pressed="draft.colorMode === 'original'" @click="draft.colorMode = 'original'"><span class="graphics-colour-strip" :style="{ background: spectrum }" /><span>Original spectrum<Check v-if="draft.colorMode === 'original'" :size="11" /></span></button>
              <button type="button" class="graphics-colour-mode" aria-label="Solid colour" :aria-pressed="draft.colorMode === 'solid'" @click="draft.colorMode = 'solid'"><span class="graphics-colour-strip" :style="{ background: draft.color }" /><span>Solid colour<Check v-if="draft.colorMode === 'solid'" :size="11" /></span></button>
              <button type="button" class="graphics-colour-mode" aria-label="Custom gradient" :aria-pressed="draft.colorMode === 'gradient'" @click="draft.colorMode = 'gradient'"><span class="graphics-colour-strip" :style="{ background: activeGradient }" /><span>Custom gradient<Check v-if="draft.colorMode === 'gradient'" :size="11" /></span></button>
            </div>
            <template v-if="draft.colorMode === 'gradient'">
              <div class="graphics-field"><span class="graphics-label">Gradient palettes</span><div class="graphics-gradient-palettes" role="group" aria-label="Gradient palettes"><button v-for="gradient in gradients" :key="gradient.name" type="button" :aria-label="`${gradient.name} gradient`" :aria-pressed="draft.gradientColors.join() === gradient.colors.join()" @click="chooseGradient(gradient.colors)"><span :style="{ background: gradientCss(gradient.colors) }" /><span>{{ gradient.name }}<Check v-if="draft.gradientColors.join() === gradient.colors.join()" :size="11" /></span></button></div></div>
              <div class="graphics-gradient-editor"><div class="graphics-gradient-ribbon" :style="{ background: activeGradient }" role="img" aria-label="Custom gradient preview" /><div class="graphics-gradient-stops" role="group" aria-label="Gradient colours"><label v-for="(_, index) in draft.gradientColors" :key="index" class="graphics-stop"><span class="graphics-stop-colour" :style="{ background: draft.gradientColors[index] }"><input v-model="draft.gradientColors[index]" type="color" :aria-label="`Gradient colour ${index + 1}`" /></span><span>{{ index + 1 }}</span></label><button type="button" class="graphics-square-action" :disabled="draft.gradientColors.length >= 7" aria-label="Add gradient colour" title="Add gradient colour" @click="draft.gradientColors.push('#ffffff')"><Plus :size="14" /></button><button type="button" class="graphics-square-action" :disabled="draft.gradientColors.length <= 2" aria-label="Remove last gradient colour" title="Remove last gradient colour" @click="draft.gradientColors.pop()"><Minus :size="14" /></button></div><p class="graphics-help">Choose each colour to edit the gradient. {{ draft.gradientColors.length }} of 7 stops.</p></div>
            </template>
            <p v-if="draft.colorMode === 'original'" class="graphics-help">The original spectrum moves from deep ember to a bright, glowing tip.</p>
            <div class="graphics-field"><span class="graphics-label">{{ draft.colorMode === 'solid' ? 'Bar & accent colour' : 'Accent colour' }}<span class="graphics-muted">{{ draft.colorMode === 'solid' ? 'Bar, tip & time cues' : 'Tip & time cues' }}</span></span><div class="graphics-accent-row"><div class="graphics-palette" role="group" aria-label="Accent palette"><button v-for="colour in palette" :key="colour.color" type="button" :aria-label="`Use ${colour.name} accent`" :title="colour.name" :aria-pressed="draft.color.toLowerCase() === colour.color" :style="{ background: colour.color }" @click="draft.color = colour.color"><Check v-if="draft.color.toLowerCase() === colour.color" :size="12" :style="{ color: colour.color === '#ffffff' ? '#182c36' : '#ffffff' }" /></button></div><label class="graphics-custom-colour"><span :style="{ background: draft.color }" /><input v-model="draft.color" type="color" aria-label="Graphics accent colour" /><code>{{ draft.color.toUpperCase() }}</code></label></div></div>
          </section>

          <section class="graphics-section" aria-labelledby="graphics-details-heading">
            <div class="graphics-section-heading"><Timer :size="15" /><h3 id="graphics-details-heading">On-screen details</h3></div>
            <div class="graphics-detail-list"><div v-for="detail in details.filter(detail => detail.key !== 'timer' || draft.template !== 'flame')" :key="detail.key" class="graphics-detail"><label class="graphics-switch-row"><span><strong>{{ detail.label }}</strong><small>{{ detail.detail }}</small></span><span class="graphics-switch"><input v-model="draft[detail.key]" type="checkbox" :aria-label="detail.label" /><span aria-hidden="true" /></span></label><div v-if="detail.key === 'timer' && draft.timer" class="graphics-segment" role="group" aria-label="Timer display"><button type="button" :aria-pressed="draft.timerMode === 'remaining'" @click="draft.timerMode = 'remaining'">Time remaining</button><button type="button" :aria-pressed="draft.timerMode === 'elapsed'" @click="draft.timerMode = 'elapsed'">Elapsed time</button></div></div></div>
            <div class="graphics-field"><span class="graphics-label">Graphics size</span><div class="graphics-segment" role="group" aria-label="Graphics size"><button v-for="size in (['small', 'medium', 'large'] as const)" :key="size" type="button" :aria-pressed="draft.size === size" @click="draft.size = size">{{ size[0].toUpperCase() + size.slice(1) }}</button></div></div>
          </section>

          <section class="graphics-section" aria-labelledby="graphics-presets-heading">
            <div class="graphics-section-heading"><Bookmark :size="15" /><h3 id="graphics-presets-heading">Saved looks</h3><span>Reuse your favourites</span></div>
            <label v-if="presets.length" class="graphics-field"><span class="graphics-label">Saved presets</span><select v-model="selectedPreset" class="graphics-input" @change="loadPreset"><option value="">Choose a preset</option><option v-for="preset in presets" :key="preset.name" :value="preset.name">{{ preset.name }}</option></select></label>
            <div class="graphics-preset"><input v-model="presetName" class="graphics-input" maxlength="48" aria-label="Graphics preset name" placeholder="Name this look…" @keydown.enter="savePreset" /><Button variant="secondary" size="sm" :disabled="!presetName.trim()" @click="savePreset">Save preset</Button></div>
            <p class="graphics-help">Presets are saved with this presentation when you apply your changes.</p>
            <button v-if="selectedPreset" class="graphics-remove" type="button" @click="presets = presets.filter(p => p.name !== selectedPreset); selectedPreset = ''"><Trash2 :size="12" />Remove selected preset</button>
          </section>
        </div>

        <aside class="graphics-preview-column" aria-label="Audience preview">
          <div class="graphics-preview-heading"><span><Monitor :size="15" />Audience preview</span><span class="graphics-draft-badge">Draft</span></div>
          <div class="graphics-preview-frame"><canvas ref="canvas" width="960" height="540" class="graphics-preview" aria-label="Presentation graphics preview" /></div>
          <div class="graphics-preview-meta"><span>{{ item?.title || channel.name }}</span><span>{{ styleLabel }}</span></div>
          <div class="graphics-preview-timing"><label class="graphics-position-label" for="graphics-preview-position"><span><Timer :size="14" />Preview time</span><span>{{ previewLabel }}</span></label><input id="graphics-preview-position" v-model.number="previewPercent" type="range" min="0" max="100" step="1" class="graphics-range" aria-label="Preview timer position" /><div class="graphics-preview-points"><button type="button" @click="previewPercent = 0">Start</button><button type="button" @click="previewPercent = 50">Midway</button><button type="button" @click="previewPercent = countdownPosition">Countdown</button></div></div>
          <div class="graphics-preview-note"><SlidersHorizontal :size="15" /><p>Preview changes before they reach your audience.<br /><span>Scrubbing here won’t move your presentation.</span></p></div>
          <div class="graphics-preview-summary"><span v-if="draft.progress"><Flame :size="12" />Progress</span><span v-if="draft.timer && draft.template !== 'flame'">Timer</span><span v-if="draft.countdown">Countdown</span><span v-if="draft.warning">Warning</span><span v-if="draft.caption">Caption</span><span v-if="!draft.progress && (!draft.timer || draft.template === 'flame') && !draft.countdown && !draft.warning && !draft.caption">Audience graphics hidden</span></div>
        </aside>
      </div>
      <footer class="graphics-footer" data-slot="dialog-footer"><span class="graphics-footer-note"><Monitor :size="13" />Program, streams, recordings &amp; screens</span><div><Button variant="ghost" :disabled="saving" @click="emit('update:open', false)">Cancel</Button><Button class="graphics-apply" :disabled="saving || !canEdit" @click="apply">{{ saving ? 'Applying…' : 'Apply to Program' }}</Button></div></footer>
    </DialogContent>
  </Dialog>
</template>
<style scoped>
:global(.graphics-dialog){width:1180px;max-width:calc(100vw - 40px);height:min(870px,calc(100dvh - 48px));max-height:calc(100dvh - 48px);padding:0;gap:0;overflow:hidden;border-radius:16px;background:#18191c;box-shadow:0 32px 100px #0008;transition-property:opacity,transform}
.graphics-header{display:flex;flex-direction:row;align-items:center;flex:0 0 auto;gap:12px;padding:21px 26px;border-bottom:1px solid #ffffff0d;text-align:left}.graphics-heading-icon{display:grid;place-items:center;width:38px;height:38px;border-radius:10px;background:#ffffff05;border:1px solid #ffffff0c;color:#a7d6e5;flex-shrink:0}.graphics-title{margin:0;font-size:17px;font-weight:600;letter-spacing:-.025em}.graphics-description{margin-top:3px;font-size:12px;color:#92969f}
.graphics-layout{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);flex:1 1 0%;min-height:0;overflow:hidden}.graphics-controls{min-width:0;min-height:0;overflow-y:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#ffffff25 transparent;padding:0 26px 28px;scroll-padding-block:20px;outline:none}.graphics-controls:focus-visible { outline: 1px solid var(--accent); outline-offset: -1px; }.graphics-section{display:grid;gap:16px;padding:24px 0;border-bottom:1px solid #ffffff0b}.graphics-section:last-child{border:0;padding-bottom:4px}.graphics-section-heading{display:flex;align-items:center;gap:8px;color:#a7abb4;margin-bottom:1px}.graphics-section-heading h3{color:#eceef2;font-size:13px;font-weight:600;letter-spacing:-.01em}.graphics-section-heading>span{margin-left:auto;font-size:11px;color:#858993}.graphics-field{display:grid;gap:9px;min-width:0}.graphics-label{display:flex;align-items:center;gap:6px;color:#b7bbc4;font-size:12px;font-weight:500}.graphics-muted{margin-left:auto;font-size:10px;color:#7d8591;font-weight:400}.graphics-help{color:#9097a2;font-size:11px;line-height:1.6;margin:0}.graphics-field-row{display:flex;align-items:center;justify-content:space-between;gap:10px}.graphics-value{display:flex;gap:5px;align-items:center;background:#111316;border:1px solid #ffffff10;border-radius:5px;padding:3px 7px;font-size:11px;font-variant-numeric:tabular-nums;color:#c9d2dd}.graphics-value small{font-size:10px;color:#838d9b}
.graphics-templates{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:9px}.graphics-style-card{display:grid;gap:5px;min-width:0;padding:9px 11px 12px;text-align:left;border:1px solid #ffffff13;border-radius:9px;background:#1e2024;transition:background .15s,border-color .15s}.graphics-original{grid-column:1/-1}.graphics-style-card:hover,.graphics-mini-card:hover,.graphics-colour-mode:hover{background:#25292e;border-color:#ffffff35}.graphics-style-card[aria-pressed=true],.graphics-mini-card[aria-pressed=true],.graphics-colour-mode[aria-pressed=true]{border-color:#ddfb739c;background:#ddfb7309;box-shadow:0 0 0 1px #ddfb7316}.graphics-style-sample{height:52px;border-radius:5px;background:#101215;overflow:hidden;margin-bottom:4px}.graphics-original .graphics-style-sample{height:58px}.graphics-card-label{display:flex;align-items:center;gap:6px;color:#c8cdd6;font-size:12px;font-weight:500}.graphics-card-label>svg{margin-left:auto;color:#9edbf4;flex-shrink:0}.graphics-card-detail{color:#858e9b;font-size:10px;line-height:1.5}.graphics-default{font-size:9px;font-weight:400;padding:2px 5px;border:1px solid #ffffff13;border-radius:4px;color:#9dabb9}.graphics-style-card[aria-pressed=true] .graphics-card-label{color:#b1e3f8}
.graphics-switch{position:relative;display:inline-flex;width:31px;height:18px;flex-shrink:0;cursor:pointer}.graphics-heading-switch{margin-left:auto}.graphics-switch input{position:absolute;inset:0;opacity:0;margin:0;cursor:pointer;width:100%;height:100%;z-index:1}.graphics-switch>span{display:block;width:100%;height:100%;background:#3c414a;border:1px solid #ffffff0c;border-radius:20px;transition:background .15s}.graphics-switch>span::after{content:'';position:absolute;top:3px;left:3px;width:12px;height:12px;border-radius:50%;background:#b8c0ca;transition:transform .15s,background .15s}.graphics-switch input:checked+span{background:#a5dced;border-color:#c1e7f4}.graphics-switch input:checked+span::after{background:#203543;transform:translateX(13px)}.graphics-switch input:focus-visible+span{outline:2px solid #ddfb73;outline-offset:3px}
.graphics-position-options{display:grid;grid-template-columns:1fr 1fr;gap:9px}.graphics-position-options button{display:flex;align-items:center;gap:10px;padding:9px 11px;border:1px solid #ffffff13;border-radius:7px;background:#1e2024;font-size:11px;color:#9da7b5}.graphics-position-options button[aria-pressed=true]{color:#b1e3f8;border-color:#ddfb7366;background:#ddfb7308}.graphics-position-options button>svg{margin-left:auto}.graphics-position-mini{position:relative;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;width:44px;height:27px;border:1px solid #ffffff25;border-radius:3px;background:#111316;overflow:hidden}.graphics-position-mini i{position:absolute;left:0;width:100%;height:2px;background:currentColor}.graphics-position-mini.at-top i{top:0}.graphics-position-mini.at-bottom i{bottom:0}.graphics-position-mini b{width:18px;height:2px;background:#ffffff22}.graphics-position-mini b:last-child{width:12px}.graphics-controls input[type=range],.graphics-range{width:100%;min-width:0;accent-color:#a5dced;cursor:pointer;height:15px}
.graphics-tip-options{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:7px}.graphics-icon-options{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:7px}.graphics-mini-card{position:relative;display:grid;gap:5px;padding:6px 6px 9px;min-width:0;border:1px solid #ffffff13;border-radius:8px;background:#1e2024;color:#aeb8c5;font-size:10px;text-align:center}.graphics-tip-sample,.graphics-icon-sample{display:block;height:44px;overflow:hidden;border-radius:4px;background:#111316}.graphics-icon-sample{height:38px}.graphics-mini-check{position:absolute;right:5px;top:5px;color:#a5dced}.graphics-mini-card[aria-pressed=true]{color:#b1e3f8}
.graphics-colour-modes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.graphics-colour-mode{display:grid;gap:9px;min-width:0;padding:8px;border:1px solid #ffffff13;border-radius:8px;background:#1e2024;color:#adb7c4}.graphics-colour-strip{height:25px;border-radius:4px;border:1px solid #ffffff0d}.graphics-colour-mode>span:last-child{display:flex;align-items:center;justify-content:space-between;gap:4px;font-size:10px;text-align:left}.graphics-colour-mode>span>svg{flex-shrink:0;color:#9edbf4}.graphics-gradient-palettes{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}.graphics-gradient-palettes button{display:grid;gap:6px;text-align:left;color:#929dab;border-radius:5px;font-size:10px}.graphics-gradient-palettes button>span:first-child{display:block;height:24px;border-radius:5px;border:1px solid #ffffff15}.graphics-gradient-palettes button>span:last-child{display:flex;align-items:center;justify-content:space-between}.graphics-gradient-palettes button[aria-pressed=true]{color:#b1e3f8}.graphics-gradient-palettes button[aria-pressed=true]>span:first-child{box-shadow:0 0 0 2px #18191c,0 0 0 3px #ddfb7380}.graphics-gradient-editor{display:grid;gap:12px;padding:12px;border:1px solid #ffffff13;border-radius:8px;background:#141619}.graphics-gradient-ribbon{height:18px;border-radius:4px;border:1px solid #ffffff12}.graphics-gradient-stops{display:flex;gap:9px;align-items:flex-start;flex-wrap:wrap}.graphics-stop{display:grid;gap:5px;text-align:center;font-size:9px;color:#788494}.graphics-stop-colour{position:relative;display:block;width:28px;height:28px;border-radius:5px;box-shadow:inset 0 0 0 1px #ffffff25;overflow:hidden}.graphics-stop input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}.graphics-stop-colour:focus-within{outline:2px solid #ddfb73;outline-offset:3px}.graphics-square-action{display:grid;place-items:center;width:28px;height:28px;border-radius:5px;border:1px solid #ffffff18;background:#ffffff04;color:#b4bdcb}.graphics-square-action:disabled{opacity:.3}.graphics-square-action:hover:not(:disabled){background:#ffffff0a}
.graphics-accent-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}.graphics-palette{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.graphics-palette button{display:grid;place-items:center;width:23px;height:23px;border-radius:50%;border:1px solid #ffffff20}.graphics-palette button[aria-pressed=true]{box-shadow:0 0 0 2px #18191c,0 0 0 3px #ddfb73}.graphics-custom-colour{position:relative;display:flex;align-items:center;gap:8px;border:1px solid #ffffff18;padding:7px 9px;border-radius:6px;background:#21242a;cursor:pointer}.graphics-custom-colour>span{width:15px;height:15px;border-radius:3px;border:1px solid #ffffff20}.graphics-custom-colour input{position:absolute;inset:0;width:100%;height:100%;opacity:0;cursor:pointer}.graphics-custom-colour code{color:#bbc5d1;font:10px ui-monospace,SFMono-Regular,monospace}.graphics-custom-colour:focus-within{outline:2px solid #ddfb73;outline-offset:3px}
.graphics-detail-list{display:grid;border:1px solid #ffffff10;border-radius:8px;overflow:hidden;background:#1b1e22}.graphics-detail{padding:12px;border-bottom:1px solid #ffffff09}.graphics-detail:last-child{border:0}.graphics-switch-row{display:flex;align-items:center;justify-content:space-between;gap:12px;cursor:pointer}.graphics-switch-row strong{display:block;font-size:12px;font-weight:500;color:#c2cbd7}.graphics-switch-row small{display:block;font-size:10px;line-height:1.5;color:#7f8a99;margin-top:3px}.graphics-segment{display:flex;padding:3px;gap:3px;border:1px solid #ffffff0b;border-radius:7px;background:#101215}.graphics-detail .graphics-segment{margin-top:12px}.graphics-segment button{display:flex;flex:1;align-items:center;justify-content:center;padding:7px 9px;border:1px solid transparent;border-radius:4px;color:#909ba9;font-size:11px;font-weight:500}.graphics-segment button[aria-pressed=true]{background:#293640;border-color:#ddfb7326;color:#b6e8fa;box-shadow:0 1px 3px #0004}.graphics-segment button:hover{color:#c7e3ef}.graphics-input{width:100%;min-width:0;border-radius:7px;border:1px solid #ffffff13;background:#222428;color:#e8eaf0;font-size:12px;line-height:20px;padding:8px 10px;outline:none}.graphics-input:focus{border-color:#ddfb7380;box-shadow:0 0 0 3px #ddfb730c}.graphics-input::placeholder{color:#747e8b}.graphics-input option{background:#222428}.graphics-preset{display:flex;gap:8px;align-items:center}.graphics-preset :deep(button){height:37px;font-size:11px;padding-inline:12px;border:1px solid #ffffff15;border-radius:7px}.graphics-remove{display:flex;align-items:center;gap:6px;text-align:left;color:#909ba9;font-size:11px;width:fit-content}.graphics-remove:hover{color:#fda4af}
.graphics-preview-column{min-width:0;padding:25px 26px;border-left:1px solid #ffffff0b;background:#121417;overflow-y:auto;scrollbar-width:thin}.graphics-preview-heading{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:23px;color:#c6ccd6;font-size:12px;font-weight:500}.graphics-preview-heading>span:first-child{display:flex;align-items:center;gap:7px}.graphics-draft-badge{padding:3px 7px;border:1px solid #ffffff10;border-radius:4px;color:#8997a8;font-size:10px;font-weight:400}.graphics-preview-frame{padding:6px;background:#1c1f24;border:1px solid #ffffff13;border-radius:10px;box-shadow:0 14px 40px #0003}.graphics-preview{display:block;width:100%;aspect-ratio:16/9;border-radius:5px;background:#101820}.graphics-preview-meta{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:14px 2px;font-size:10px;color:#8692a0}.graphics-preview-meta>span:first-child{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#a2adba}.graphics-preview-meta>span:last-child{flex-shrink:0}.graphics-preview-timing{padding:17px 14px 10px;border:1px solid #ffffff0b;border-radius:8px;background:#1a1d22;margin-top:10px}.graphics-position-label{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11px;color:#9fabb9;margin:0 0 10px}.graphics-position-label>span:first-child{display:flex;align-items:center;gap:6px}.graphics-position-label>span:last-child{font-variant-numeric:tabular-nums;color:#bcc7d5}.graphics-preview-points{display:flex;align-items:center;justify-content:space-between;margin-top:6px}.graphics-preview-points button{font-size:10px;padding:4px 0;color:#8293a7}.graphics-preview-points button:hover{color:#b6e8fa}.graphics-preview-note{display:flex;align-items:start;gap:10px;margin-top:22px;color:#929ba8;font-size:11px;line-height:1.7}.graphics-preview-note svg{flex-shrink:0;margin-top:2px;color:#74818f}.graphics-preview-note p span{color:#747d8a}.graphics-preview-summary{display:flex;gap:6px;flex-wrap:wrap;margin-top:16px}.graphics-preview-summary>span{display:flex;align-items:center;gap:5px;border:1px solid #ffffff0c;background:#ffffff03;border-radius:5px;padding:4px 7px;color:#7d8d9e;font-size:9px}
.graphics-footer{display:flex;align-items:center;justify-content:space-between;flex:0 0 auto;gap:16px;padding:16px 26px;border-top:1px solid #ffffff0e;background:#1a1c20}.graphics-footer-note{display:flex;align-items:center;gap:7px;color:#858e9b;font-size:11px}.graphics-footer>div{display:flex;align-items:center;gap:9px;margin-left:auto}.graphics-footer :deep(button){height:35px;padding-inline:17px;font-size:12px;border-radius:7px}.graphics-footer :deep(.graphics-apply){background:#b5e3f4;color:#182c36;border:1px solid #c2e9f8;box-shadow:inset 0 1px #ffffff4d}.graphics-footer :deep(.graphics-apply:hover){background:#cfedfa}button:focus-visible{outline:2px solid #ddfb73;outline-offset:3px}
@media(max-width:1000px) and (min-width:761px){.graphics-layout{grid-template-columns:minmax(0,1.12fr) minmax(0,1fr)}.graphics-controls,.graphics-preview-column{padding-inline:18px}.graphics-section-heading>span{display:none}.graphics-card-label{font-size:11px}.graphics-colour-mode>span:last-child{font-size:9px}.graphics-tip-options{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media(max-width:760px){:global(.graphics-dialog){width:calc(100vw - 20px);max-width:calc(100vw - 20px);height:calc(100dvh - 24px);max-height:calc(100dvh - 24px);border-radius:12px}.graphics-header{padding:17px 18px;gap:10px}.graphics-heading-icon{width:32px;height:32px}.graphics-title{font-size:16px}.graphics-description{font-size:11px;max-width:230px;line-height:1.5;padding-right:10px}.graphics-layout{display:flex;flex-direction:column;overflow-y:auto;overscroll-behavior:contain;scroll-padding-block:16px}.graphics-controls{flex:0 0 auto;overflow:visible;padding:0 18px 24px}.graphics-preview-column{order:-1;flex:0 0 auto;padding:18px;border-left:0;border-bottom:1px solid #ffffff0c;overflow:visible}.graphics-preview-heading{margin-bottom:13px}.graphics-preview-frame{max-width:480px;margin:0 auto}.graphics-preview-meta{padding-bottom:0}.graphics-preview-note,.graphics-preview-summary{display:none}.graphics-preview-timing{margin-top:15px;padding:12px 11px 8px}.graphics-section{padding-block:22px}.graphics-section-heading>span{font-size:10px}.graphics-style-card{padding:7px 8px 10px}.graphics-card-label{font-size:11px}.graphics-card-detail{font-size:9px}.graphics-default{font-size:8px}.graphics-style-sample{height:46px}.graphics-tip-options{grid-template-columns:repeat(2,minmax(0,1fr))}.graphics-icon-options{gap:5px}.graphics-mini-card{font-size:9px;padding-inline:4px}.graphics-icon-sample{height:32px}.graphics-colour-modes{gap:6px}.graphics-colour-mode{padding:6px}.graphics-colour-mode>span:last-child{font-size:9px;line-height:1.4}.graphics-muted{font-size:9px}.graphics-footer{padding:12px 18px}.graphics-footer-note{display:none}.graphics-footer>div{width:100%;justify-content:space-between}.graphics-footer :deep(button){padding-inline:13px}.graphics-gradient-stops{gap:8px}}
@media(prefers-reduced-motion:reduce){button,.graphics-switch>span,.graphics-switch>span::after{transition:none}}
</style>
