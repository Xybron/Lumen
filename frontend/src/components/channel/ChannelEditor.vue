<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { VueDraggable } from 'vue-draggable-plus';
import { Plus, Upload, KeyboardIcon, LayoutList, LayoutGrid, FolderPlus, Folder, ChevronDown, ChevronRight, MoreHorizontal, Play, FileText, Image, Presentation, HandHeart, NotebookPen, SlidersHorizontal } from 'lucide-vue-next';
import { useDropZone } from '@vueuse/core';
import { toast } from 'vue-sonner';
import SlideCard from '@/components/dashboard/SlideCard.vue';
import PresentationGraphicsDialog from './PresentationGraphicsDialog.vue';
import PresentationDocumentImportDialog from './PresentationDocumentImportDialog.vue';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useContentStore } from '@/stores/content';
import { usePlaybackStore } from '@/stores/playback';
import { useIdentityStore } from '@/stores/identity';
import { usePresenceStore } from '@/stores/presence';
import { api, mediaUrl } from '@/lib/api';
import { shortId } from '@/lib/ids';
import { presentationOutline, groupOptions, groupDescendants, orderPresentationGroups } from '@/lib/presentation-groups';
import { probeVideoDurationMs } from '@/lib/media-duration';
import { MAX_MEDIA_BYTES, mediaExtensions } from '@/lib/studio/media-library';
import type { Channel, Item, PresentationGroup } from '@/types';

const props = defineProps<{ channel: Channel | null }>();
const emit = defineEmits<{ (e: 'edit', item: Item): void; (e: 'open-shortcuts'): void }>();
const content = useContentStore(), playback = usePlaybackStore(), identity = useIdentityStore(), presence = usePresenceStore();
const canEdit = computed(() => !!props.channel && identity.can(props.channel.id, 'author') && !playback.readOnly);
const notesMode = computed(() => props.channel?.kind === 'notes');
const editorPlaylistId = computed(() => props.channel?.playlistId ?? null);
const editorPlaylist = computed(() => content.playlists.find(playlist => playlist.id === editorPlaylistId.value) ?? null);
const graphicsOpen = ref(false), chooserOpen = ref(false), selectedGroup = ref('');
const importOpen = ref(false), importKind = ref<'pdf'|'powerpoint'>('pdf');
const importDestination = ref<{playlistId:string;channelId:string;groupId?:string}|null>(null);
function restoredView(): 'list'|'grid' { try { return localStorage.getItem('lumen.slideView') === 'grid' ? 'grid' : 'list'; } catch { return 'list'; } }
const slideView = ref<'list'|'grid'>(restoredView());
function setSlideView(view: 'list'|'grid') { slideView.value = view; try { localStorage.setItem('lumen.slideView', view); } catch { /* The layout remains usable when storage is unavailable. */ } }
const collapsed = ref(new Set<string>());
watch(() => props.channel?.id, () => { selectedGroup.value = ''; chooserOpen.value = false; collapsed.value = new Set(); });
const outline = computed(() => editorPlaylist.value ? presentationOutline(editorPlaylist.value) : []);
const options = computed(() => editorPlaylist.value ? groupOptions(editorPlaylist.value) : []);
const visibleRows = computed(() => {
  let hiddenDepth = Infinity;
  return outline.value.filter(row => {
    if (row.depth > hiddenDepth) return false;
    hiddenDepth = row.group && collapsed.value.has(row.group.id) ? row.depth : Infinity;
    return true;
  });
});
function toggleGroup(id: string) { const next = new Set(collapsed.value); next.has(id) ? next.delete(id) : next.add(id); collapsed.value = next; }
function groupCount(id: string) { const ids = groupDescendants(editorPlaylist.value?.groups ?? [], id); return playback.items.filter(item => item.groupId && ids.has(item.groupId)).length; }
function jumpGroup(id: string) { const ids = groupDescendants(editorPlaylist.value?.groups ?? [], id); const index = playback.items.findIndex(item => item.groupId && ids.has(item.groupId) && item.type !== 'section'); if (index >= 0) playback.jumpTo(index); }
const groupOpen = ref(false), groupName = ref(''), groupParent = ref(''), groupEditing = ref<string|null>(null);
const parentOptions = computed(() => options.value.filter(option => !groupEditing.value || !groupDescendants(editorPlaylist.value?.groups ?? [], groupEditing.value).has(option.id)));
function editGroup(group?: PresentationGroup) { groupEditing.value = group?.id ?? null; groupName.value = group?.name ?? ''; groupParent.value = group?.parentId ?? selectedGroup.value; groupOpen.value = true; }
async function saveGroup() {
  if (!editorPlaylistId.value || !canEdit.value || !groupName.value.trim()) return;
  if (groupEditing.value) await content.updateGroup(editorPlaylistId.value, groupEditing.value, groupName.value, groupParent.value || undefined);
  else { const id = await content.addGroup(editorPlaylistId.value, groupName.value, groupParent.value || undefined); if (id) selectedGroup.value = id; }
  groupOpen.value = false;
}
async function removeGroup() { if (!editorPlaylistId.value || !groupEditing.value || !canEdit.value) return; await content.removeGroup(editorPlaylistId.value, groupEditing.value); if (selectedGroup.value === groupEditing.value) selectedGroup.value = ''; groupOpen.value = false; }
const dropTarget = ref<HTMLElement|null>(null), mediaInput = ref<HTMLInputElement|null>(null);
const uploading = ref(false), uploadStatus = ref('');
const { isOverDropZone } = useDropZone(dropTarget, { onDrop: handleDrop });
const creatingNote = ref(false);
async function newContent() {
  if (!notesMode.value) { chooserOpen.value = !chooserOpen.value; return; }
  if (creatingNote.value) return;
  creatingNote.value = true;
  try { await addSlide('notes'); } finally { creatingNote.value = false; }
}
const slideCount = computed(() => playback.items.filter(item => item.type !== 'section').length);
const choices = [{kind:'prayer',label:'Prayer',detail:'Prayer points & scripture',icon:HandHeart},{kind:'media',label:'Media',detail:'Images & videos',icon:Image},{kind:'pdf',label:'PDF',detail:'Document pages',icon:FileText},{kind:'powerpoint',label:'PowerPoint',detail:'Static slides',icon:Presentation},{kind:'notes',label:'Notes',detail:'Write, listen & present',icon:NotebookPen}] as const;
async function addSlide(kind: typeof choices[number]['kind']) {
  if (!editorPlaylistId.value || !props.channel || !canEdit.value || (notesMode.value && kind !== 'notes')) return;
  chooserOpen.value = false;
  if (kind === 'pdf' || kind === 'powerpoint') { importKind.value = kind; importDestination.value = {playlistId:editorPlaylistId.value,channelId:props.channel.id,groupId:selectedGroup.value || undefined}; importOpen.value = true; return; }
  const item = await content.addItem(editorPlaylistId.value, { type: kind === 'media' ? 'image' : kind, groupId: options.value.some(option => option.id === selectedGroup.value) ? selectedGroup.value : undefined, title: kind === 'notes' ? 'Untitled notes' : '', body:'', layout: kind === 'notes' ? 'key-points' : 'general', background: kind === 'notes' ? {kind:'gradient',gradient:'linear-gradient(135deg, #182b45 0%, #0b111e 100%)',overlayOpacity:0} : {kind:'color',color:'#831843',overlayOpacity:0}, ...(kind === 'notes' ? {typography:{size:'lg',align:'left',weight:500}} : {}) });
  if (item) emit('edit', item);
}
async function imported(result: {sourceName:string;sourceType:'pdf'|'powerpoint';totalPages:number;pages:Array<{page:number;title:string;path:string}>}) {
  const destination = importDestination.value;
  if (!destination || !identity.can(destination.channelId,'author') || presence.controlledByOther(destination.channelId)) return;
  const groupId = shortId('grp');
  const saved = await content.save(draft => {
    const playlist = draft.playlists.find(p => p.id === destination.playlistId); if (!playlist) return;
    (playlist.groups ??= []).push({id:groupId,name:result.sourceName.replace(/\.(pdf|pptx?)$/i,'').slice(0,100),parentId:destination.groupId});
    playlist.items.push(...result.pages.map(page => ({id:shortId('itm'),type:'image' as const,title:page.title,groupId,durationMs:draft.settings.defaultDurationMs,background:{kind:'image' as const,src:page.path,fit:'contain' as const,overlayOpacity:0},document:{type:result.sourceType,sourceName:result.sourceName,page:page.page,totalPages:result.totalPages}})));
    orderPresentationGroups(playlist);
  });
  if (saved) { selectedGroup.value = groupId; toast.success(`${result.pages.length} slides added to ${result.sourceName}`); }
}
function selectMedia(event: Event) { const files = (event.target as HTMLInputElement).files; if (files) void handleDrop(Array.from(files)); }
async function onSorted(event: {oldIndex?:number;newIndex?:number}) {
  if (!canEdit.value || !editorPlaylistId.value || event.oldIndex == null || event.newIndex == null) return;
  const from = visibleRows.value[event.oldIndex], to = visibleRows.value[event.newIndex];
  if (!from?.item || !to || from.key === to.key) return;
  if (to.group) await content.updateItem(editorPlaylistId.value, from.item.id, {groupId:to.group.id});
  else if (from.index != null && to.index != null) await content.reorderItems(editorPlaylistId.value, from.index, to.index);
}
async function handleDrop(files: File[] | null) {
  if (!files || !editorPlaylistId.value || uploading.value || !canEdit.value || notesMode.value) return;
  // Capture the destination once: changing channels during a slow upload must
  // not send later files to a different playlist.
  const playlistId = editorPlaylistId.value;
  const channelId = props.channel!.id;
  const canWriteDestination = () => identity.can(channelId, 'author') && !presence.controlledByOther(channelId)
    && content.channels.some(channel => channel.id === channelId && channel.playlistId === playlistId);
  uploading.value = true;
  try {
    for (const file of files) {
      if (!canWriteDestination()) break;
      if (!file.size) throw new Error('This file is empty. Choose another file.');
      if (file.size > MAX_MEDIA_BYTES) throw new Error('This file is larger than 512 MB. Choose a smaller file.');
      const kind = mediaExtensions.video.test(file.name) ? 'video' : mediaExtensions.image.test(file.name) ? 'image' : null;
      if (!kind) throw new Error('Choose an image or video. Use PDF or PowerPoint from New slide for documents.');
      uploadStatus.value = `Uploading ${kind}…`;
      const onProgress = (percent: number) => { uploadStatus.value = percent < 100 ? `Uploading ${kind}… ${percent}%` : kind === 'video' ? 'Preparing video for playback…' : 'Finishing upload…'; };
      if (kind === 'image' || kind === 'video') {
        const { path } = await api.uploadMedia('backgrounds', file, { onProgress });
        if (!canWriteDestination()) throw new Error('Presentation control changed while uploading. The slide was not added.');
        uploadStatus.value = kind === 'video' ? 'Adding video slide…' : 'Adding image slide…';
        const durationMs = kind === 'video' ? await probeVideoDurationMs(mediaUrl(path)!) ?? 30000 : 30000;
        await content.addItem(playlistId, {
          type: kind,
          groupId: selectedGroup.value || undefined,
          title: file.name,
          durationMs,
          background: { kind, src: path, fit: 'cover', overlayOpacity: 0, ...(kind === 'video' ? { loop: false, muted: false, volume: 1 } : {}) },
        });
        toast.success(kind === 'video' ? 'Video added to this presentation.' : 'Image added to this presentation.');
      }
    }
  } catch (error) {
    toast.error(error instanceof TypeError ? 'Lumen could not reach this station. Check the connection and try again.' : (error as Error).message || 'This file could not be imported. Try again.');
  } finally {
    uploading.value = false;
    uploadStatus.value = '';
    if (mediaInput.value) mediaInput.value.value = '';
  }
}

</script>
<template>
  <main ref="dropTarget" class="panel presentation-editor" :class="{'drop-active':isOverDropZone && !notesMode}" :aria-label="notesMode ? 'Notes editor' : 'Slide editor'">
    <input v-if="!notesMode" ref="mediaInput" type="file" class="hidden" accept=".png,.jpg,.jpeg,.webp,.gif,.mp4,.webm,.mov,.m4v" multiple aria-label="Upload presentation media" @change="selectMedia" />
    <header class="presentation-editor-heading">
      <div class="presentation-editor-title">
        <h1>{{ channel?.name ?? 'Choose a channel' }}</h1>
        <p class="presentation-editor-meta">{{ slideCount }} {{ slideCount === 1 ? 'slide' : 'slides' }}<template v-if="editorPlaylist?.groups?.length"><span>·</span>{{ editorPlaylist.groups.length }} {{ editorPlaylist.groups.length === 1 ? 'group' : 'groups' }}</template></p>
      </div>
      <TooltipProvider :delay-duration="350" :skip-delay-duration="100">
        <div class="presentation-editor-actions" role="group" :aria-label="notesMode ? 'Notes tools' : 'Presentation tools'">
          <div class="presentation-view-options" role="group" aria-label="Slide view">
            <Tooltip v-for="view in (['list', 'grid'] as const)" :key="view">
              <TooltipTrigger as-child>
                <button type="button" class="presentation-tool-button presentation-view-button" :aria-label="view === 'list' ? 'List view' : 'Grid view'" :aria-pressed="slideView === view" @click="setSlideView(view)">
                  <LayoutList v-if="view === 'list'" :size="16" :stroke-width="1.75" /><LayoutGrid v-else :size="16" :stroke-width="1.75" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" :side-offset="8">{{ view === 'list' ? 'List view' : 'Grid view' }}</TooltipContent>
            </Tooltip>
          </div>
          <span class="presentation-tool-divider" aria-hidden="true" />
          <Tooltip v-if="!notesMode">
            <TooltipTrigger as-child>
              <button type="button" class="presentation-tool-button" aria-label="Graphics" aria-haspopup="dialog" :disabled="!canEdit" @click="graphicsOpen = true"><SlidersHorizontal :size="16" :stroke-width="1.75" /></button>
            </TooltipTrigger>
            <TooltipContent side="bottom" :side-offset="8">Presentation graphics</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger as-child>
              <button type="button" class="presentation-tool-button" aria-label="Keyboard shortcuts" aria-haspopup="dialog" @click="emit('open-shortcuts')"><KeyboardIcon :size="16" :stroke-width="1.75" /></button>
            </TooltipTrigger>
            <TooltipContent side="bottom" :side-offset="8">Keyboard shortcuts</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger as-child>
              <button type="button" class="presentation-tool-button presentation-add-button" :aria-label="notesMode ? 'New note' : 'New slide'" :disabled="!canEdit || creatingNote" :aria-expanded="notesMode ? undefined : chooserOpen" @click="newContent"><Plus :size="16" :stroke-width="1.75" /></button>
            </TooltipTrigger>
            <TooltipContent side="bottom" :side-offset="8">{{ notesMode ? 'New note' : 'New slide' }}</TooltipContent>
          </Tooltip>
        </div>
      </TooltipProvider>
    </header>
    <div v-if="chooserOpen && !notesMode" class="content-chooser" aria-label="Choose content type"><button v-for="choice in choices.filter(choice => choice.kind !== 'notes')" :key="choice.kind" @click="addSlide(choice.kind)"><component :is="choice.icon" :size="18"/><b>{{choice.label}}</b><small>{{choice.detail}}</small></button></div>
    <div class="outline-toolbar"><label class="min-w-0">Add to <select v-model="selectedGroup" aria-label="Destination group"><option value="">{{ notesMode ? 'Notes' : 'Presentation' }}</option><option v-for="option in options" :key="option.id" :value="option.id">{{option.label}}</option></select></label><button :disabled="!canEdit" @click="editGroup()"><FolderPlus :size="13"/>New group</button><button v-if="!notesMode" :disabled="!canEdit || uploading" @click="mediaInput?.click()" title="Import images or videos"><Upload :size="13"/><span>Media</span></button></div>
    <div v-if="!editorPlaylist || !outline.length" class="presentation-empty"><div><component :is="notesMode ? NotebookPen : Presentation" :size="32" class="mx-auto text-accent mb-4"/><b>{{editorPlaylist ? notesMode ? 'Capture the next thought' : 'Build your presentation' : 'Choose a channel'}}</b><p class="text-xs text-white/50 mt-2">{{ notesMode ? 'Write a point, collect a transcript, and shape it into slides.' : 'Add prayer points, media or documents. Organize them into groups.' }}</p><Button v-if="editorPlaylist" class="mt-5" variant="accent" :disabled="!canEdit || creatingNote" @click="newContent"><Plus :size="14"/>{{ notesMode ? 'New note' : 'New slide' }}</Button></div></div>
    <VueDraggable v-else :model-value="visibleRows" handle=".drag-handle" :animation="180" :disabled="!canEdit" ghost-class="opacity-30" class="presentation-slide-list" :class="slideView==='grid'?'slide-grid':'slide-list'" @end="onSorted">
      <div v-for="row in visibleRows" :key="row.key" :class="row.group?'group-row':'slide-outline-row'" :style="{'--depth':Math.min(row.depth,4)}">
        <template v-if="row.group"><button class="group-toggle" :aria-label="`${collapsed.has(row.group.id)?'Expand':'Collapse'} ${row.group.name}`" :aria-expanded="!collapsed.has(row.group.id)" @click="toggleGroup(row.group.id)"><ChevronRight v-if="collapsed.has(row.group.id)" :size="14"/><ChevronDown v-else :size="14"/><Folder :size="14"/><b>{{row.group.name}}</b><small>{{groupCount(row.group.id)}}</small></button><button class="group-action" :disabled="playback.readOnly || !groupCount(row.group.id)" :aria-label="`Show first slide in ${row.group.name}`" @click="jumpGroup(row.group.id)"><Play :size="12"/></button><button class="group-action" :disabled="!canEdit" :aria-label="`Edit group ${row.group.name}`" @click="editGroup(row.group)"><MoreHorizontal :size="15"/></button></template>
        <SlideCard v-else-if="row.item" :item="row.item" :index="row.index!" :is-current="row.index===playback.index" :view="slideView" :editable="canEdit" :playlist-id="editorPlaylistId" @edit="canEdit && emit('edit',row.item)" @duplicate="canEdit && content.duplicateItem(editorPlaylistId!,row.item.id)" @delete="canEdit && content.removeItem(editorPlaylistId!,row.item.id)" @jump="playback.jumpTo(row.index!)"/>
      </div>
    </VueDraggable>
    <div class="presentation-editor-footer"><span role="status">{{!canEdit?'Read-only workspace':uploading?uploadStatus:'Double-click to show · Drag to reorder'}}</span><span>{{playback.mode==='auto'?'Auto advance':'Manual control'}}</span></div>
  </main>
  <PresentationGraphicsDialog v-if="channel && !notesMode" v-model:open="graphicsOpen" :channel="channel"/>
  <PresentationDocumentImportDialog v-if="importDestination" v-model:open="importOpen" :kind="importKind" :channel-id="importDestination.channelId" @imported="imported"/>
  <Dialog v-model:open="groupOpen"><DialogContent class="sm:max-w-md"><DialogHeader><DialogTitle>{{groupEditing?'Edit group':'New group'}}</DialogTitle></DialogHeader><label class="group-field">Group name<input v-model="groupName" maxlength="100" placeholder="e.g. Prayer focus" @keydown.enter="saveGroup"/></label><label class="group-field">Inside<select v-model="groupParent"><option value="">{{ notesMode ? 'Notes' : 'Presentation' }}</option><option v-for="option in parentOptions" :key="option.id" :value="option.id">{{option.label}}</option></select></label><p class="text-xs text-white/45">Groups organize any content type. Removing a group keeps all its slides.</p><DialogFooter><Button v-if="groupEditing" variant="ghost" @click="removeGroup">Ungroup slides</Button><Button variant="ghost" @click="groupOpen=false">Cancel</Button><Button variant="accent" :disabled="!groupName.trim()" @click="saveGroup">Save group</Button></DialogFooter></DialogContent></Dialog>
</template>
<style scoped>
.presentation-editor{min-width:0;min-height:0;flex:1;display:flex;flex-direction:column;overflow:hidden}
.presentation-editor-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:10px 14px;padding:14px 16px;border-bottom:1px solid var(--border-hair);flex-shrink:0}
.presentation-editor-title{flex:1 1 100px;min-width:0}.presentation-editor-title h1{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;font-weight:600;letter-spacing:-.01em;color:#edf0f4}.presentation-editor-meta{display:flex;align-items:center;gap:6px;margin-top:4px;font-size:10px;color:#858e9b}.presentation-editor-meta>span{color:#59616d}
.presentation-editor-actions{display:flex;flex:0 0 auto;align-items:center;gap:6px;margin-left:auto}.presentation-view-options{display:flex;gap:3px;padding:3px;border:1px solid #ffffff0b;border-radius:8px;background:#101214}.presentation-tool-button{display:grid;place-items:center;flex:0 0 auto;width:34px;height:34px;padding:0;border:1px solid #ffffff12;border-radius:7px;color:#9aa4b1;background:#ffffff03;cursor:pointer;transition:background .15s,border-color .15s,color .15s}.presentation-tool-button svg{width:16px;height:16px;stroke-width:1.75;flex-shrink:0}.presentation-tool-button:hover{color:#e4ecf4;border-color:#ffffff28;background:#ffffff08}.presentation-tool-button:focus-visible{outline:2px solid #ddfb73;outline-offset:3px}.presentation-tool-button:disabled{opacity:.35;pointer-events:none}.presentation-view-button{width:28px;height:28px;border-color:transparent;background:transparent;border-radius:5px}.presentation-view-button[aria-pressed=true]{color:var(--text-primary);background:var(--surface-3);border-color:var(--border-glow);box-shadow:0 1px 3px #0003}.presentation-tool-divider{height:20px;width:1px;margin-inline:2px;background:#ffffff12}.presentation-add-button{color:var(--text-primary);background:var(--surface-3);border-color:var(--border-glow)}.presentation-add-button:hover,.presentation-add-button[aria-expanded=true]{color:var(--text-primary);background:var(--bg-hover);border-color:var(--border-glow)}
.presentation-slide-list{flex:1;min-height:0;overflow-y:auto;padding:12px 12px 100px;scroll-padding-block:12px 100px}.slide-list{display:flex;flex-direction:column;gap:6px}.slide-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));align-content:start;gap:10px}.slide-outline-row{min-width:0;margin-left:calc(var(--depth)*12px)}.slide-grid .slide-outline-row{margin-left:0}.group-row{grid-column:1/-1;display:flex;align-items:center;gap:4px;min-height:38px;padding-left:calc(var(--depth)*12px);border-bottom:1px solid var(--border-hair);flex-shrink:0}.group-toggle{display:flex;align-items:center;gap:8px;flex:1;min-width:0;text-align:left;color:#d5d8dc;font-size:12px}.group-toggle b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.group-toggle small{color:#ffffff66;font-size:10px}.group-action{padding:7px;color:#ffffff80}.group-action:hover{color:white}.group-action:disabled{opacity:.35}
.outline-toolbar{display:flex;align-items:center;gap:12px;padding:8px 14px;border-bottom:1px solid var(--border-hair);font-size:10px;color:#ffffff80;flex-shrink:0}.outline-toolbar label{display:flex;align-items:center;gap:6px;flex:1}.outline-toolbar select{background:transparent;max-width:190px;min-width:0;color:#d4d8df;outline:none}.outline-toolbar option{background:#202124}.outline-toolbar button{display:flex;align-items:center;gap:5px;white-space:nowrap}.outline-toolbar button:disabled{opacity:.3}
.content-chooser{padding:12px;display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:6px;border-bottom:1px solid var(--border-hair);flex-shrink:0}.content-chooser button{display:flex;flex-direction:column;align-items:flex-start;gap:6px;padding:12px 8px;border:1px solid var(--border-hair);border-radius:9px;text-align:left;color:#dbe4ec;font-size:11px;background:#ffffff03}.content-chooser button:hover{border-color:#ddfb7380;background:#ddfb730a}.content-chooser svg{color:var(--accent)}.content-chooser small{color:#ffffff65;font-size:9px}
.presentation-editor-footer{min-height:30px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:5px;padding:7px 12px;border-top:1px solid var(--border-hair);color:var(--text-muted);font-size:9px;flex-shrink:0}.presentation-empty{flex:1;min-height:200px;overflow-y:auto;display:flex;align-items:center;justify-content:center;padding:30px 20px 110px;text-align:center}.drop-active{outline:2px solid var(--accent);outline-offset:-3px;background:#ddfb7308}.group-field{display:grid;gap:7px;font-size:12px;color:#ffffff99}.group-field input,.group-field select{background:#202124;border:1px solid var(--border-hair);border-radius:8px;padding:9px;color:white;outline:none}
@media(max-width:1100px){.content-chooser{grid-template-columns:repeat(3,minmax(0,1fr))}.outline-toolbar{gap:8px;padding-inline:10px}.outline-toolbar select{max-width:140px}}@media(max-width:450px){.presentation-editor-heading{padding:12px;gap:9px}.presentation-editor-actions{gap:4px}.presentation-tool-button{width:32px;height:32px}.presentation-view-button{width:26px;height:26px}.presentation-tool-divider{margin-inline:1px}.slide-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.content-chooser{grid-template-columns:repeat(2,minmax(0,1fr))}.presentation-slide-list{padding:8px 8px 110px}.outline-toolbar select{max-width:115px}}@media(prefers-reduced-motion:reduce){.presentation-tool-button{transition:none}}
</style>
