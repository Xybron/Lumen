<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue';
import { Smartphone, Copy, Check, LoaderCircle, ShieldCheck, X } from 'lucide-vue-next';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { useConfirmation } from '@/composables/useConfirmation';
import { mobileRequest } from '@/lib/mobile/controller';
import type { MobileManagement, MobilePairing, MobilePermissions } from '../../../../shared/mobile-controller';

const open = ref(false), management = ref<MobileManagement | null>(null), pairing = ref<MobilePairing | null>(null), busy = ref(false), error = ref(''), copied = ref('');
const name = ref('Phone operator'), permissions = ref<MobilePermissions>({ studio: true, channels: true, audio: true });
const { confirmAction } = useConfirmation();
let timer: ReturnType<typeof setInterval> | undefined, disposed = false;
async function refresh() {
  if (!open.value || busy.value || document.hidden) return;
  try { const value = await mobileRequest<MobileManagement>('/manage'); if (!disposed && open.value) management.value = value; }
  catch (cause) { if (!disposed && open.value) error.value = cause instanceof Error ? cause.message : 'Mobile access is unavailable.'; }
}
watch(open, value => { clearInterval(timer); error.value = ''; pairing.value = null; copied.value = ''; if (value) { void refresh(); timer = setInterval(() => { void refresh(); }, 5000); } });
onBeforeUnmount(() => { disposed = true; clearInterval(timer); });
async function createPairing() {
  if (busy.value) return; busy.value = true; error.value = ''; pairing.value = null;
  try { pairing.value = await mobileRequest<MobilePairing>('/manage/pair', { method: 'POST', body: JSON.stringify({ name: name.value, permissions: permissions.value }) }); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not create pairing.'; }
  finally { busy.value = false; }
}
async function copy(value: string, label: string) {
  try { await navigator.clipboard.writeText(value); copied.value = label; }
  catch { error.value = 'Clipboard access is unavailable. Select and copy the value below.'; }
}
async function revoke(id: string, deviceName: string) {
  if (!await confirmAction({ title: `Disconnect ${deviceName}?`, description: 'This phone loses its station access immediately. Your desktop, scenes, stream and Main audio will not change.', confirmLabel: 'Disconnect phone', tone: 'danger' })) return;
  busy.value = true; error.value = '';
  try { await mobileRequest(`/manage/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  catch (cause) { error.value = cause instanceof Error ? cause.message : 'Could not disconnect the phone.'; }
  finally { busy.value = false; }
  await refresh();
}
function expiry(value: number) { return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
</script>

<template>
  <button type="button" class="s-button mobile-control-entry" aria-label="Mobile control" title="Pair a phone for emergency control" @click="open = true"><Smartphone :size="15" /><span class="button-label">Mobile</span></button>
  <Dialog :open="open" @update:open="open = $event"><DialogContent class="mobile-management"><DialogHeader><DialogTitle><span class="mobile-management-title"><Smartphone :size="21" />Mobile control</span></DialogTitle><DialogDescription>A focused phone controller. Rendering, recording and streaming stay on this station.</DialogDescription></DialogHeader>
    <div v-if="management" class="mobile-management-status"><ShieldCheck :size="18" /><div><b>{{ management.enabled ? 'Secure phone listener enabled' : 'Local controller available' }}</b><p>{{ management.enabled ? 'Connect your phone to the station’s network and use the secure address below.' : 'For phone access, run the secure mobile startup command. The ordinary station API stays private.' }}</p><a v-if="management.url" :href="management.url" target="_blank" rel="noopener noreferrer">{{ management.url }}</a><RouterLink v-else to="/remote" target="_blank">Open controller on this computer ↗</RouterLink></div></div>
    <section class="mobile-management-pair"><h3>Pair a device</h3><label>Device label<input v-model="name" maxlength="60" placeholder="e.g. Emergency operator" /></label><fieldset><legend>Allow this phone to control</legend><label><input v-model="permissions.studio" type="checkbox" />Scenes and Cut/Fade</label><label><input v-model="permissions.channels" type="checkbox" />Scripture, lyrics and presentations</label><label><input v-model="permissions.audio" type="checkbox" />Main audio mute and volume</label></fieldset><button class="mobile-management-primary" :disabled="busy || !Object.values(permissions).some(Boolean)" @click="createPairing"><LoaderCircle v-if="busy" :size="15" />Create one-time pairing</button>
      <div v-if="pairing" class="mobile-pairing-result" data-team-private data-mobile-private><span>Expires at {{ expiry(pairing.expiresAt) }} · single use</span><label>Pairing code<input :value="pairing.code" readonly spellcheck="false" @focus="($event.target as HTMLInputElement).select()" /></label><button @click="copy(pairing.code, 'code')"><Check v-if="copied === 'code'" :size="14" /><Copy v-else :size="14" />{{ copied === 'code' ? 'Code copied' : 'Copy code' }}</button><template v-if="pairing.url"><label>Private pairing link<input :value="pairing.url" readonly spellcheck="false" @focus="($event.target as HTMLInputElement).select()" /></label><button @click="copy(pairing.url!, 'link')"><Check v-if="copied === 'link'" :size="14" /><Copy v-else :size="14" />{{ copied === 'link' ? 'Link copied' : 'Copy pairing link' }}</button></template><small>Share only with your operator. Watch links never grant control.</small></div>
    </section>
    <section class="mobile-management-devices"><h3>Paired devices <span>{{ management?.devices.length ?? 0 }}</span></h3><div v-for="device in management?.devices ?? []" :key="device.id" class="mobile-management-device"><Smartphone :size="17" /><div><b>{{ device.name }}</b><small>{{ management?.lease?.deviceId === device.id ? 'Has phone control' : 'Monitor only' }} · expires {{ expiry(device.expiresAt) }}</small></div><button :disabled="busy" :aria-label="`Disconnect ${device.name}`" @click="revoke(device.id, device.name)"><X :size="17" /></button></div><p v-if="!management?.devices.length">No phones paired. Pairing and control leases expire automatically.</p></section><p v-if="error" class="mobile-management-error" role="alert">{{ error }}</p><p class="mobile-management-note">Desktop control remains available. Phone access is temporary, scoped to this station and revoked when its backend restarts.</p>
  </DialogContent></Dialog>
</template>

<style scoped>
.mobile-management { max-width: 520px; gap: 22px; }
.mobile-management-title { display: flex; align-items: center; gap: 10px; }
.mobile-management-title svg { color: var(--accent); }
.mobile-management-status { display: flex; gap: 11px; padding: 14px; background: var(--accent-soft); border: 1px solid #7dd3fc22; border-radius: 9px; }
.mobile-management-status > svg { flex-shrink: 0; color: var(--accent); margin-top: 2px; }
.mobile-management-status b { font-size: 12px; font-weight: 550; }.mobile-management-status p { color: var(--text-muted); font-size: 11px; line-height: 1.7; margin: 5px 0; }.mobile-management-status a { display: inline-block; color: var(--accent); margin-top: 3px; font-size: 11px; overflow-wrap: anywhere; }
.mobile-management h3 { font-size: 13px; font-weight: 550; margin: 0 0 13px; }.mobile-management h3 > span { color: var(--text-subtle); font-size: 10px; margin-left: 6px; }
.mobile-management label { display: grid; gap: 7px; font-size: 11px; color: var(--text-muted); }.mobile-management input:not([type=checkbox]) { width: 100%; background: var(--surface-2); border: 1px solid var(--border-glow); color: var(--text-primary); border-radius: 7px; min-height: 42px; padding: 10px 12px; font: inherit; font-size: 12px; }
.mobile-management fieldset { border: 0; margin: 16px 0; display: grid; gap: 11px; padding: 0; }.mobile-management legend { color: var(--text-subtle); font-size: 10px; margin-bottom: 11px; }.mobile-management fieldset label { display: flex; align-items: center; gap: 9px; color: var(--text-muted); }.mobile-management input[type=checkbox] { accent-color: var(--accent); width: 15px; height: 15px; }
.mobile-management button:not(.mobile-control-entry) { min-height: 40px; border: 1px solid var(--border-glow); color: var(--text-primary); background: var(--surface-2); border-radius: 7px; padding: 9px 12px; font-size: 12px; display: inline-flex; align-items: center; justify-content: center; gap: 7px; }.mobile-management button:disabled { opacity: .45; }.mobile-management .mobile-management-primary { background: var(--accent) !important; color: #163449 !important; border-color: var(--accent) !important; width: 100%; font-weight: 550; }
.mobile-pairing-result { display: grid; gap: 11px; border: 1px solid var(--border-glow); border-radius: 8px; padding: 13px; margin-top: 13px; }.mobile-pairing-result > span { color: #d6b580; font-size: 10px; }.mobile-pairing-result small { color: var(--text-subtle); font-size: 10px; line-height: 1.6; }.mobile-pairing-result input { font-family: ui-monospace, monospace !important; font-size: 11px !important; }
.mobile-management-devices { border-top: 1px solid var(--border-hair); padding-top: 17px; }.mobile-management-devices > p { color: var(--text-subtle); font-size: 11px; line-height: 1.7; margin: 0; }.mobile-management-device { display: flex; align-items: center; gap: 10px; padding: 10px 0; border-top: 1px solid var(--border-hair); }.mobile-management-device > svg { color: var(--text-subtle); }.mobile-management-device > div { display: grid; flex: 1; gap: 3px; min-width: 0; }.mobile-management-device b { font-size: 12px; font-weight: 500; overflow-wrap: anywhere; }.mobile-management-device small { color: var(--text-subtle); font-size: 10px; }
.mobile-management-note { color: var(--text-subtle); font-size: 10px; line-height: 1.7; margin: -4px 0 0; }.mobile-management-error { border: 1px solid #eea39a33; color: #e7b2a9; padding: 11px; border-radius: 8px; font-size: 11px; line-height: 1.7; margin: 0; }
</style>
