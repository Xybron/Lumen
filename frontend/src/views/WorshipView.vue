<script setup lang="ts">
import { computed,ref,watch,onMounted,onBeforeUnmount,nextTick } from 'vue';
import { BookOpen,Music2,Search,ArrowRight,ChevronLeft,ChevronRight,Plus,Library,EyeOff,Check,Pin,Pencil,ArrowUp,ArrowDown,X,History,LoaderCircle,ExternalLink } from 'lucide-vue-next';
import { toast } from 'vue-sonner';
import { useWorshipStore } from '@/stores/worship';
import { useIdentityStore } from '@/stores/identity';
import { usePresenceStore } from '@/stores/presence';
import { useContentStore } from '@/stores/content';
import { useStudioStore } from '@/stores/studio';
import { openProjection } from '@/lib/tauri';
import { worshipRequest } from '@/lib/worship/api';
import ChannelCuePreview from '@/components/channel/ChannelCuePreview.vue';
import BibleLibraryDialog from '@/components/channel/BibleLibraryDialog.vue';
import SongEditorDialog from '@/components/channel/SongEditorDialog.vue';
import LocalListeningPanel from '@/components/channel/LocalListeningPanel.vue';
import type { Channel } from '@/types';
import type { Verse,Song,SongSection,CueSelection,WorshipCommand,ScriptureSelection,ScriptureSearchResult,ScriptureSearchChoice,LyricsSearchHit } from '../../../shared/worship';

const props=defineProps<{channel:Channel}>(),store=useWorshipStore(),identity=useIdentityStore(),presence=usePresenceStore(),content=useContentStore(),studio=useStudioStore();
const workspace=ref<HTMLElement|null>(null);
const scripture=computed(()=>props.channel.kind==='scripture'),state=computed(()=>store.workspaces[props.channel.id]),draft=computed(()=>store.drafts[props.channel.id]);
const canOperate=computed(()=>identity.can(props.channel.id,'author')&&presence.isMine(props.channel.id));
const sending=computed(()=>!!store.saving[props.channel.id]);
const preparing=computed(()=>!!store.preparing[props.channel.id]);
const canSend=computed(()=>!!draft.value&&canOperate.value&&!sending.value&&!preparing.value);
// Channels publish content only. Presence is informational, and comes from the
// committed Studio composition rather than the currently selected draft scene.
const onProgram=computed(()=>{
  const production=studio.state;if(!production||!state.value?.live||state.value.blanked)return false;
  const sources=new Set(production.sources.filter(source=>source.kind==='channel'&&source.channelId===props.channel.id).map(source=>source.id));
  return production.program?.layers.some(layer=>layer.kind==='source'&&sources.has(layer.sourceId??'')&&layer.visible&&layer.opacity>0&&layer.x<100&&layer.y<100&&layer.x+layer.width>0&&layer.y+layer.height>0)??false;
});
const canLibrary=computed(()=>identity.me?.isAdmin||identity.grants.some(g=>['owner','author'].includes(g.role)));
const query=ref(''),searchInput=ref<HTMLInputElement>(),verses=ref<Verse[]>([]),songs=ref<Song[]>([]),allSongs=ref<Song[]>([]),searching=ref(false),searchError=ref(''),loading=ref(true),loadError=ref('');
const searchInfo=ref<ScriptureSearchResult|null>(null),searchActive=ref(-1),completedSearch=ref('');
const songMatches=ref<Record<string,LyricsSearchHit['match']>>({}),selectedSongSnapshot=ref<Song|null>(null);
const rememberedSongs=ref<Record<string,Song>>({});
const searchChoices=computed(()=>searchInfo.value?.resolution.suggestions??[]);
const searchResultsId=computed(()=>`${scripture.value?'scripture':'lyrics'}-results-${props.channel.id}`);
const activeSearchId=computed(()=>searchActive.value<0?undefined:`${searchResultsId.value}-${searchActive.value}`);
const searchLabel=computed(()=>{
  const info=searchInfo.value;
  if(!query.value.trim())return '';
  if(searching.value)return 'Searching…';
  if(info?.resolution.kind==='ambiguous')return searchChoices.value.length?'Choose a book':'No matching passages';
  if(info?.resolution.label)return info.resolution.label;
  return info?.keywordMode==='relaxed'?'Matching key words':'Matching words';
});
const books=ref<{book:number;name:string;chapters:number}[]>([]),book=ref(43),chapter=ref(3),libraryOpen=ref(false),songOpen=ref(false),editingSong=ref<Song|null>(null),legacySections=ref<SongSection[]>([]),selectedSongId=ref('');
// A search hit may be outside the first 500 browse entries. Keep its canonical
// song available as queries change, without treating the browse cap as a library
// limit or losing the matched section while the operator is preparing it.
const selectedSong=computed(()=>[selectedSongSnapshot.value,...allSongs.value].filter((song):song is Song=>!!song&&song.id===selectedSongId.value).sort((a,b)=>b.revision-a.revision)[0]);
const setlist=computed(()=>state.value?.setlist.map(id=>allSongs.value.find(s=>s.id===id)??rememberedSongs.value[id]).filter((s):s is Song=>!!s)??[]);
const chapters=computed(()=>books.value.find(b=>b.book===book.value)?.chapters??1);
const passage=ref<ScriptureSelection|null>(null),rangeEnd=ref(1);
const legacyItems=computed(()=>content.content.playlists.find(p=>p.id===props.channel.playlistId)?.items??[]);
let timer:number|undefined,searchAbort:AbortController|undefined,searchRevision=0,disposed=false;
let openingSearchFocus=scripture.value;
function cancelOpeningSearchFocus(){
  openingSearchFocus=false;
  window.removeEventListener('pointerdown',cancelOpeningSearchFocus,true);
  window.removeEventListener('keydown',cancelOpeningSearchFocus,true);
}
// The input is mounted only after the workspace loads. Focus that first mount,
// not each result or cue update, and never reclaim focus after the operator has
// started interacting elsewhere while the channel was loading.
watch(searchInput,input=>{
  if(!input||!openingSearchFocus)return;
  cancelOpeningSearchFocus();
  if(disposed||!scripture.value||!input.isConnected||libraryOpen.value||songOpen.value)return;
  if(document.querySelector('[role="dialog"],[role="menu"],[role="listbox"]:not([data-channel-search-results]),[data-studio-layer-menu],[data-animation-editor]'))return;
  if(document.activeElement?.closest('[data-testid="floating-multiview"],[data-testid="studio-multiview"]'))return;
  input.focus({preventScroll:true});
},{flush:'post'});
function run(task:Promise<unknown>){void task.catch(()=>{});}
async function action(command:WorshipCommand){if(canOperate.value)await store.command(props.channel.id,command).catch(()=>{});}
async function prepare(selection:CueSelection){try{await store.prepare(props.channel.id,selection);}catch(e){toast.error((e as Error).message);}}
function verseSelection(v:Verse):ScriptureSelection{return {kind:'scripture',versionId:v.versionId,book:v.book,chapter:v.chapter,verse:v.verse};}
function prepareVerse(v:Verse,event?:MouseEvent){
  // A native double-click emits two clicks before dblclick. The first prepares;
  // the second must not start a redundant request or race the explicit send.
  if(event&&event.detail>1)return;
  run(prepare(verseSelection(v)));
}
function sendVerse(v:Verse){
  if(disposed||!canOperate.value||sending.value||state.value?.versionId!==v.versionId)return;
  // The server resolves this exact selection authoritatively. Never await a
  // private preview or read an older draft here: its response may arrive late,
  // fail, or be superseded, and must never trigger another publication.
  run(action({type:'take',selection:verseSelection(v)}));
}
function rememberSong(song:Song){
  const index=allSongs.value.findIndex(existing=>existing.id===song.id);
  if(index>=0){if(allSongs.value[index].revision<song.revision)allSongs.value[index]=song;}
  else rememberedSongs.value[song.id]=song;
  const keep=new Set([...(state.value?.setlist??[]),song.id,selectedSongId.value]);
  for(const id of Object.keys(rememberedSongs.value))if(!keep.has(id))delete rememberedSongs.value[id];
}
async function loadSongs(){
  allSongs.value=await worshipRequest<Song[]>('/songs');
  const missing=(state.value?.setlist??[]).filter(id=>!allSongs.value.some(song=>song.id===id));
  let cursor=0;
  // Pinned songs remain addressable even when the alphabetical library browse
  // is capped. Hydrate only those IDs, with bounded request concurrency.
  await Promise.all(Array.from({length:Math.min(4,missing.length)},async()=>{
    while(cursor<missing.length){const id=missing[cursor++];try{const song=await worshipRequest<Song>(`/songs/${encodeURIComponent(id)}`);if(!disposed)rememberedSongs.value[id]=song;}catch{/* A removed song must not prevent opening the remaining library. */}}
  }));
}
function searchKey(){return `${props.channel.id}\n${scripture.value?state.value?.versionId??'KJV':'lyrics'}\n${query.value}`;}
function resetScriptureResults(){verses.value=[];searchInfo.value=null;searchActive.value=-1;passage.value=null;}
async function search(){
  searchAbort?.abort();const abort=new AbortController();searchAbort=abort;const revision=++searchRevision,key=searchKey();searching.value=true;searchError.value='';passage.value=null;
  try{
    if(scripture.value){const result=await worshipRequest<ScriptureSearchResult>(`/scripture?version=${encodeURIComponent(state.value?.versionId??'KJV')}&q=${encodeURIComponent(query.value)}`,{signal:abort.signal});if(revision!==searchRevision||disposed)return;verses.value=result.verses;searchInfo.value=result;completedSearch.value=key;const r=result.reference;
      if(r?.chapter&&r.verse&&r.endVerse&&r.endVerse>=r.verse&&r.endVerse-r.verse<=11&&result.verses.length===r.endVerse-r.verse+1)passage.value={kind:'scripture',versionId:state.value.versionId,book:r.book,chapter:r.chapter,verse:r.verse,endVerse:r.endVerse};
    }else{const result=await worshipRequest<LyricsSearchHit[]>(`/song-search?q=${encodeURIComponent(query.value)}`,{signal:abort.signal});if(revision!==searchRevision||disposed)return;songs.value=result.map(hit=>hit.song);songMatches.value=Object.fromEntries(result.map(hit=>[hit.song.id,hit.match]));completedSearch.value=key;}
  }catch(e){if(!abort.signal.aborted&&revision===searchRevision&&!disposed)searchError.value=(e as Error).message;}finally{if(revision===searchRevision)searching.value=false;}
}
watch(query,()=>{clearTimeout(timer);searchAbort?.abort();searchRevision++;searchActive.value=-1;searching.value=true;searchError.value='';if(scripture.value)resetScriptureResults();else{songs.value=[];songMatches.value={};}timer=window.setTimeout(search,120);});
watch(()=>state.value?.versionId,async version=>{if(!version||!scripture.value)return;searchAbort?.abort();searchRevision++;resetScriptureResults();try{const available=await worshipRequest<typeof books.value>(`/books?version=${encodeURIComponent(version)}`);if(disposed||version!==state.value?.versionId)return;books.value=available;if(!books.value.some(b=>b.book===book.value)){book.value=books.value[0]?.book??1;chapter.value=1;}const selection=draft.value?.selection;if(selection?.kind==='scripture'&&selection.versionId!==version){store.drafts[props.channel.id]=null;await prepare({...selection,versionId:version});}await search();}catch(e){if(!disposed&&version===state.value?.versionId)searchError.value=(e as Error).message;}},{immediate:true});
watch(()=>draft.value?.selection,selection=>{if(selection?.kind==='scripture')rangeEnd.value=selection.endVerse??selection.verse;else if(selection?.kind==='lyrics')selectedSongId.value=selection.songId;},{immediate:true});
watch(()=>store.listening[props.channel.id]?.result?.suggestedQuery,value=>{if(value&&scripture.value&&document.activeElement!==searchInput.value)query.value=value;});
function browse(){chapter.value=Math.min(chapter.value,chapters.value);query.value=`${books.value.find(b=>b.book===book.value)?.name??''} ${chapter.value}`;}
function chooseBook(choice:ScriptureSearchChoice){query.value=choice.label;searchInput.value?.focus();}
async function moveSearch(e:KeyboardEvent){
  if(e.isComposing||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey||!['ArrowDown','ArrowUp'].includes(e.key))return;
  e.preventDefault();
  if(searching.value||completedSearch.value!==searchKey())return;
  const count=scripture.value?searchChoices.value.length||verses.value.length:songs.value.length;if(!count)return;
  searchActive.value=(searchActive.value+(e.key==='ArrowDown'?1:searchActive.value<0?0:-1)+count)%count;
  await nextTick();if(activeSearchId.value)document.getElementById(activeSearchId.value)?.scrollIntoView({block:'nearest'});
}
async function firstResult(event?:KeyboardEvent){if(event?.isComposing)return;event?.preventDefault();clearTimeout(timer);const original=searchKey();if(searching.value||completedSearch.value!==original)await search();if(disposed||original!==searchKey()||searchError.value)return;const index=Math.max(0,searchActive.value);if(scripture.value){if(searchChoices.value[index])chooseBook(searchChoices.value[index]);else if(passage.value&&searchActive.value<0)run(prepare(passage.value));else if(verses.value[index])prepareVerse(verses.value[index]);}else if(songs.value[index])selectSearchSong(songs.value[index]);}
function selectSong(song:Song,sectionId?:string){const section=sectionId?song.sections.find(section=>section.id===sectionId):song.sections[0];if(!section)return;selectedSongSnapshot.value=song;selectedSongId.value=song.id;rememberSong(song);run(prepare({kind:'lyrics',songId:song.id,sectionId:section.id}));}
function selectSearchSong(song:Song,event?:MouseEvent){if(event&&event.detail>1||searching.value||completedSearch.value!==searchKey()||!songs.value.some(result=>result.id===song.id))return;selectSong(song,songMatches.value[song.id]?.sectionId??undefined);}
function songMatchLabel(song:Song){const match=songMatches.value[song.id];return match?.sectionId?song.sections.find(section=>section.id===match.sectionId)?.label??'Lyrics':'Lyrics';}
function editSong(song:Song|null){editingSong.value=song;legacySections.value=[];songOpen.value=true;}
async function savedSong(song:Song){await loadSongs();await search();selectSong(song);}
function pin(song:Song){rememberSong(song);const ids=state.value.setlist;run(action({type:'setlist',songIds:ids.includes(song.id)?ids.filter(id=>id!==song.id):[...ids,song.id]}));}
function reorder(i:number,d:number){const ids=[...state.value.setlist];const [id]=ids.splice(i,1);ids.splice(i+d,0,id);run(action({type:'setlist',songIds:ids}));}
function migrateLyrics(){editingSong.value=null;legacySections.value=legacyItems.value.flatMap(item=>item.stanzas?.length?item.stanzas.map(s=>({id:crypto.randomUUID(),label:s.label??item.title??'Verse',text:s.lines})):item.body?[{id:crypto.randomUUID(),label:item.title??'Verse',text:item.body}]:[]).filter(s=>s.text.trim());songOpen.value=true;}
function recentLabel(selection:CueSelection){if(selection.kind==='lyrics')return allSongs.value.find(s=>s.id===selection.songId)?.title??'Song';return `${books.value.find(b=>b.book===selection.book)?.name??'Book '+selection.book} ${selection.chapter}:${selection.verse}${selection.endVerse?'–'+selection.endVerse:''}`;}
function versionChanged(e:Event){const id=(e.target as HTMLSelectElement).value;run(action({type:'version',versionId:id}));}
function take(){if(canSend.value)run(store.take(props.channel.id));}
function keys(e:KeyboardEvent){
  if(e.defaultPrevented||e.isComposing||e.getModifierState('AltGraph')||libraryOpen.value||songOpen.value||document.querySelector('[role="dialog"][data-state="open"],[role="menu"][data-state="open"],[role="listbox"][data-state="open"],[data-studio-layer-menu]'))return;
  const target=e.target instanceof Element?e.target:null;
  if(!target)return;
  if(target.closest('[role="dialog"],[role="menu"],[data-reka-popper-content-wrapper]'))return;
  const listbox=target.closest('[role="listbox"]');
  if(listbox&&(!listbox.matches('[data-channel-search-results]')||!workspace.value?.contains(listbox)))return;
  if(!e.repeat&&(e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();searchInput.value?.focus();return;}
  if(e.key==='Enter'&&(e.metaKey||e.ctrlKey)&&!(e.metaKey&&e.ctrlKey)&&!e.altKey&&!e.shiftKey){
    if(target.closest('select,textarea,a,[contenteditable]:not([contenteditable="false"])'))return;
    // Search now exposes accessible result navigation as a combobox. Its own
    // input retains Send live; selectors and unrelated comboboxes still cannot
    // publish a prepared cue through their native Enter handling.
    if(target.closest('[role="combobox"]')&&target!==searchInput.value)return;
    const button=target.closest('button');
    // Selection leaves its Prepare button focused. Only content selectors and
    // Send live opt into this chord; unrelated controls retain native behavior.
    if(button&&(!workspace.value?.contains(button)||!button.matches('[data-channel-prepare],[data-testid="channel-send-live"]')))return;
    if(!workspace.value?.contains(target)&&target!==document.body&&target!==document.documentElement)return;
    // Consume native Enter even during a pending prepare/send or held-key repeat
    // so it cannot re-click Prepare, double-publish, or queue an old selection.
    e.preventDefault();e.stopPropagation();if(!e.repeat)take();return;
  }
  if(e.repeat)return;
  if(target.closest('input,textarea,select,button,a,[contenteditable="true"]'))return;
  if(e.key==='ArrowRight'&&state.value?.live){e.preventDefault();run(action({type:'step',direction:1}));}
  if(e.key==='ArrowLeft'&&state.value?.live){e.preventDefault();run(action({type:'step',direction:-1}));}
}
async function load(){loading.value=true;loadError.value='';try{await store.load(props.channel.id);if(!scripture.value)await loadSongs();await search();}catch(e){loadError.value=(e as Error).message;}finally{loading.value=false;}}
onMounted(()=>{
  if(openingSearchFocus){window.addEventListener('pointerdown',cancelOpeningSearchFocus,true);window.addEventListener('keydown',cancelOpeningSearchFocus,true);}
  void load();window.addEventListener('keydown',keys);
});
onBeforeUnmount(()=>{disposed=true;cancelOpeningSearchFocus();clearTimeout(timer);searchAbort?.abort();window.removeEventListener('keydown',keys);});
</script>

<template>
  <div ref="workspace" class="w-workspace">
    <h1 class="sr-only">{{channel.name}}</h1>
    <div v-if="loadError" class="w-empty panel"><p class="w-error">{{loadError}}</p><button class="w-button" @click="load">Retry</button></div>
    <div v-else-if="loading||!state" class="w-empty"><LoaderCircle :size="24" class="w-spin" /><p>Opening your channel…</p></div>
    <div v-else class="w-layout">
      <aside class="w-library panel">
        <template v-if="scripture"><div class="w-section-heading w-library-heading"><h2><BookOpen :size="15" />Your Bible</h2><button class="w-icon" aria-label="Manage Bible library" title="Manage Bible library" @click="libraryOpen=true"><Library :size="16" /></button></div>
          <label class="w-label">TRANSLATION<select :value="state.versionId" :disabled="!canOperate||store.saving[channel.id]" aria-label="Bible version" @change="versionChanged"><option v-for="v in store.versions" :key="v.id" :value="v.id" :disabled="!v.installed">{{v.id}} · {{v.installed?v.name:'Import required'}}</option></select></label>
          <span class="w-library-note">{{store.versions.find(v=>v.id===state.versionId)?.verseCount.toLocaleString()}} verses · stored locally</span>
          <div class="w-divider" /><h3 class="w-library-subheading">Browse a chapter</h3><div class="w-browse-fields"><label class="w-label">BOOK<select v-model.number="book" aria-label="Bible book" @change="chapter=1;browse()"><option v-for="b in books" :key="b.book" :value="b.book">{{b.name}}</option></select></label><label class="w-label">CHAPTER<select v-model.number="chapter" aria-label="Bible chapter" @change="browse"><option v-for="c in chapters" :key="c" :value="c">{{c}}</option></select></label></div>
          <button class="w-button wide" @click="browse">Browse verses<ArrowRight :size="14" /></button>
          <div class="w-divider" /><div class="w-section-heading"><h3>Recent passages</h3><History :size="14" /></div><p v-if="!state.recent.length" class="w-muted w-recent-empty">Sent passages appear here.</p><div v-if="state.recent.length" class="w-recent-list"><button v-for="(selection,i) in state.recent.slice(0,8)" :key="i" class="w-recent" data-channel-prepare @click="prepare(selection)">{{recentLabel(selection)}}<ChevronRight :size="12" /></button></div>
          <button class="w-button w-library-manage" @click="libraryOpen=true"><Plus :size="14" />Manage versions</button>
        </template>
        <template v-else><div class="w-section-heading w-library-heading"><h2><Music2 :size="15" />Service setlist</h2><span class="w-count">{{setlist.length}}</span></div><p class="w-muted">Pin songs in service order. Listening matches this setlist only.</p>
          <div v-if="!setlist.length" class="w-setlist-empty"><Music2 :size="26" /><p>No songs in this setlist.</p></div>
          <div v-if="setlist.length" class="w-setlist-list"><div v-for="(song,i) in setlist" :key="song.id" class="w-setlist-song" :class="{selected:selectedSongId===song.id}"><button data-channel-prepare @click="selectSong(song)"><span>{{String(i+1).padStart(2,'0')}}</span><b>{{song.title}}</b></button><div><button class="w-icon" :disabled="!canOperate||i===0" aria-label="Move song up" @click="reorder(i,-1)"><ArrowUp :size="12" /></button><button class="w-icon" :disabled="!canOperate||i===setlist.length-1" aria-label="Move song down" @click="reorder(i,1)"><ArrowDown :size="12" /></button><button class="w-icon" :disabled="!canOperate" aria-label="Remove from setlist" @click="pin(song)"><X :size="12" /></button></div></div></div>
          <button class="w-button wide" :disabled="!canLibrary" @click="editSong(null)"><Plus :size="14" />Add a song</button><button v-if="legacyItems.length" class="w-button wide" :disabled="!canLibrary" @click="migrateLyrics">Copy existing slides to a song</button>
        </template>
      </aside>

      <section class="w-search-panel panel">
        <div class="w-search-heading"><div><h2>{{scripture?'Find a passage':'Find a song'}}</h2><p>{{scripture?'A short reference or a few remembered words.':'A little of the title, or a few remembered lyrics.'}}</p></div><span class="w-search-hint"><span v-if="scripture">Double-click to send live ·</span><span v-else>↑ ↓ Choose ·</span><kbd>↵</kbd> Prepare</span></div>
        <div class="w-search-box"><Search :size="19" /><input ref="searchInput" v-model="query" :aria-label="scripture?'Search scripture':'Search songs'" :placeholder="scripture?'jn3 16, jer20 11, or a few words…':'Part of a title or a few lyrics…'" role="combobox" aria-autocomplete="list" :aria-controls="searchResultsId" :aria-expanded="scripture?!!(query.trim()&&(verses.length||searchChoices.length)):!!songs.length" :aria-activedescendant="activeSearchId" autocomplete="off" spellcheck="false" @keydown="moveSearch" @keydown.enter.exact="firstResult" /><LoaderCircle v-if="searching" :size="16" class="w-spin" /><kbd v-else>⌘ K</kbd><button v-if="query" class="w-icon" aria-label="Clear search" @click="query='' "><X :size="14" /></button></div>
        <div class="w-results-meta" aria-live="polite"><span v-if="scripture" class="w-search-interpretation"><b v-if="searchLabel">{{searchLabel}}</b><span v-if="searchInfo?.resolution.match==='corrected'" class="w-match-note">Matched book name</span><span>{{query.trim()&&!searching&&!searchChoices.length?`${verses.length} ${verses.length===1?'verse':'verses'} · `:''}}{{state.versionId}}</span></span><span v-else>{{searching?'Searching…':query.trim()?`${songs.length} ${songs.length===1?'song':'songs'} · Titles and lyrics`:`Song library · ${songs.length}`}}</span><button v-if="passage" class="w-text-button" data-channel-prepare @click="prepare(passage)">Prepare passage<ArrowRight :size="13" /></button><button v-if="!scripture" class="w-text-button" :disabled="!canLibrary" @click="editSong(null)"><Plus :size="13" />New song</button></div>
        <p v-if="searchError" class="w-error" role="alert">{{searchError}}</p>
        <div :id="scripture?searchResultsId:undefined" class="w-results" :role="scripture?'listbox':undefined" :aria-label="scripture?'Scripture search results':undefined" :data-scripture-results="scripture?true:undefined" :data-channel-search-results="scripture?true:undefined" :class="{'w-lyrics-results':!scripture,'has-selection':!scripture&&selectedSong}">
          <template v-if="scripture"><div v-if="!query.trim()" class="w-search-welcome"><BookOpen :size="28" :stroke-width="1.5" /><h3>A few keys. The right passage.</h3><p>Book names can be short. Spaces work instead of colons. Or search words you remember.</p><div><button v-for="example in [{query:'jn3 16',label:'jn3 16'},{query:'ps23',label:'ps23'},{query:'lord my shepherd',label:'lord my shepherd'}]" :key="example.query" @click="query=example.query"><span>{{example.label}}</span><ArrowRight :size="13" /></button></div><small>↑ ↓ to choose · Enter prepares · ⌘ / Ctrl + Enter sends live</small></div>
            <div v-if="searchChoices.length" class="w-search-choices"><button v-for="(choice,i) in searchChoices" :id="`${searchResultsId}-${i}`" :key="choice.reference.book" data-testid="scripture-book-choice" role="option" :aria-selected="searchActive===i" :data-search-active="searchActive===i" :class="{'keyboard-active':searchActive===i}" @click="chooseBook(choice)"><BookOpen :size="16" /><span>{{choice.label}}</span><ArrowRight :size="14" /></button><p>Choose the book you mean. Nothing goes live until you send it.</p></div>
            <button v-for="(v,i) in verses" :id="`${searchResultsId}-${i}`" :key="`${v.book}:${v.chapter}:${v.verse}`" class="w-verse-result" role="option" :aria-selected="searchActive===i" :data-search-active="searchActive===i" data-channel-prepare :class="{'keyboard-active':searchActive===i,selected:draft?.selection.kind==='scripture'&&draft.selection.book===v.book&&draft.selection.chapter===v.chapter&&draft.selection.verse===v.verse}" title="Click to prepare · Double-click to send live to this channel" aria-description="Single-click prepares this verse. Double-click sends this exact verse live to the Scripture channel without switching Studio scenes." @click="searchActive=i;prepareVerse(v,$event)" @dblclick.prevent.stop="sendVerse(v)"><span>{{v.bookName}} {{v.chapter}}:{{v.verse}}<small>{{v.versionId}}</small></span><p>{{v.text}}</p><span class="w-result-action">Prepare<ArrowRight :size="13" /></span></button>
            <div v-if="query.trim()&&!searching&&!verses.length&&!searchChoices.length&&!searchError" class="w-empty"><Search :size="28" /><h3>{{searchInfo?.resolution.kind==='invalid'?'Check this reference':'No verses found'}}</h3><p>{{searchInfo?.resolution.kind==='invalid'?'Use a book, chapter and optional verse, such as jer20 11. Chapter and verse numbers must be valid.':['reference','ambiguous'].includes(searchInfo?.resolution.kind??'')?'This passage is not present in the selected edition. Check the chapter and verse, or choose another installed version.':'Try a short reference like jer20 11, or a few distinctive words. Only your selected, installed Bible is searched.'}}</p></div>
          </template>
          <template v-else><div v-if="!songs.length&&!searching&&!searchError" class="w-empty"><Music2 :size="28" :stroke-width="1.5" /><h3>{{query.trim()?'No matching songs':'No songs yet'}}</h3><p>{{query.trim()?'Try part of the title or a few distinctive words. Only songs saved in your library are searched.':'Add a song, split it into sections, then pin it to the service setlist.'}}</p><button v-if="!query.trim()" class="w-button primary" :disabled="!canLibrary" @click="editSong(null)"><Plus :size="14" />Add your first song</button></div>
            <div :id="!scripture?searchResultsId:undefined" class="w-song-list" role="listbox" aria-label="Song search results" data-channel-search-results><div v-for="(song,i) in songs" :key="song.id" class="w-song-result" :data-search-active="searchActive===i" :class="{selected:selectedSongId===song.id,'keyboard-active':searchActive===i}"><button :id="`${searchResultsId}-${i}`" class="w-song-select" role="option" :aria-selected="searchActive===i" :data-search-active="searchActive===i" data-channel-prepare @click="searchActive=i;selectSearchSong(song,$event)"><span class="w-song-icon"><Music2 :size="17" /></span><div><h3>{{song.title}}<small v-if="songMatches[song.id]?.corrected" class="w-match-note">Similar spelling</small></h3><p>{{song.author||'Your library'}} · {{song.sections.length}} {{song.sections.length===1?'section':'sections'}}</p><p v-if="songMatches[song.id]?.kind==='lyrics'&&songMatches[song.id]?.excerpt" class="w-song-match"><b>{{songMatchLabel(song)}}</b>{{songMatches[song.id].excerpt}}</p></div></button><button class="w-icon" :class="{pinned:state.setlist.includes(song.id)}" :disabled="!canOperate" :aria-label="state.setlist.includes(song.id)?'Unpin song':'Pin song to setlist'" @click="pin(song)"><Check v-if="state.setlist.includes(song.id)" :size="15" /><Pin v-else :size="15" /></button><button class="w-icon" :disabled="!canLibrary" aria-label="Edit song" @click="editSong(song)"><Pencil :size="14" /></button></div></div>
            <div v-if="selectedSong" class="w-song-cues"><div class="w-section-heading"><h3>{{selectedSong.title}}</h3><span>SECTIONS</span></div><button v-for="(section,i) in selectedSong.sections" :key="section.id" class="w-section-cue" data-channel-prepare :class="{selected:draft?.selection.kind==='lyrics'&&draft.selection.sectionId===section.id}" @click="prepare({kind:'lyrics',songId:selectedSong.id,sectionId:section.id})"><span>{{String(i+1).padStart(2,'0')}}</span><div><b>{{section.label}}</b><p>{{section.text}}</p></div><ArrowRight :size="14" /></button></div>
          </template>
        </div>
        <LocalListeningPanel :channel-id="channel.id" :kind="channel.kind" :can-operate="canOperate" />
      </section>

      <aside class="w-cue-panel panel"><section class="w-cue-group" aria-label="Prepared cue"><div class="w-section-heading"><h2><span class="w-preview-dot" />Prepared</h2><span class="w-pill">PREVIEW ONLY</span></div>
        <div class="w-preview w-content-preview" data-testid="prepared-cue" :aria-busy="preparing"><ChannelCuePreview v-if="draft" :text="draft.text" :reference="draft.reference" :attribution="draft.attribution" /><div v-else class="w-preview-empty"><component :is="scripture?BookOpen:Music2" :size="28" :stroke-width="1" /><span>{{preparing?'Preparing content…':scripture?'Choose a verse to prepare':'Choose a song section'}}</span></div></div>
        <div class="w-cue-caption"><b>{{draft?.title||'Nothing prepared'}}</b><span>{{draft?.reference||'Your live output stays unchanged.'}}</span></div>
        <div v-if="draft?.selection.kind==='scripture'" class="w-range"><span>Verse {{draft.selection.verse}} through</span><input v-model.number="rangeEnd" type="number" :min="draft.selection.verse" :max="draft.selection.verse+11" aria-label="Passage end verse" /><button class="w-button" data-channel-prepare @click="prepare({...draft.selection,endVerse:rangeEnd})">Prepare</button></div>
        <button class="w-take" data-testid="channel-send-live" aria-keyshortcuts="Meta+Enter Control+Enter" :disabled="!canSend" :title="preparing?'Preparing the selected content…':'Publish this content to the channel. Choose the scene on Program in Studio.'" @click="take"><LoaderCircle v-if="sending||preparing" :size="15" class="w-spin" /><span>Send live</span><ArrowRight :size="16" /><kbd aria-hidden="true">⌘ ↵</kbd></button>
        <small class="w-shortcut">⌘ / Ctrl + Enter · manual control disarms listening</small></section>
        <section class="w-cue-group w-cue-group-live" aria-label="Live cue controls"><div class="w-section-heading"><h2><span class="w-live-dot" />Channel live</h2><div class="w-channel-output-actions"><button class="w-icon" aria-label="Open channel output" title="Open this channel’s text output" @click="openProjection(channel.id)"><ExternalLink :size="14" /></button><button class="w-icon" :disabled="!canOperate||!state.live||state.blanked||sending" aria-label="Clear live content" title="Clear this channel’s content without changing the Studio scene" @click="action({type:'blank',value:true})"><EyeOff :size="16" /></button></div></div>
        <div class="w-preview w-content-preview w-live-preview" data-testid="live-cue"><ChannelCuePreview v-if="state.live&&!state.blanked" :text="state.live.text" :reference="state.live.reference" :attribution="state.live.attribution" /><div v-else class="w-preview-empty"><EyeOff :size="22" /><span>{{state.blanked?'Live content cleared':'Ready when you are'}}</span></div></div>
        <p v-if="state.live&&!state.blanked" class="w-channel-live-status" :class="{'is-onair':onProgram}" data-testid="channel-live-status" :title="onProgram?'This channel is used by the committed Program scene. Updates appear there immediately.':'This content is ready. Choose and take its scene in Studio.'"><span v-if="onProgram" class="w-live-dot" />{{onProgram?'On Program':'Ready in Studio'}}</p>
        <div class="w-step-controls"><button class="w-button" :disabled="!canOperate||!state.live||store.saving[channel.id]" @click="action({type:'step',direction:-1})"><ChevronLeft :size="16" />Previous</button><button class="w-button" :disabled="!canOperate||!state.live||store.saving[channel.id]" @click="action({type:'step',direction:1})">Next<ChevronRight :size="16" /></button></div>
        <p class="w-channel-design-note">Style and arrange this channel’s text in Studio.</p></section>
        <p v-if="!canOperate" class="w-ownership">{{presence.controlledByOther(channel.id)?'Another team member controls this channel. Use Take in the channel menu to request control.':'Read-only access. You can search and prepare; an author controls the output.'}}</p>
      </aside>
    </div>
    <BibleLibraryDialog v-model:open="libraryOpen" /><SongEditorDialog v-model:open="songOpen" :song="editingSong" :initial-sections="legacySections" @saved="savedSong" />
  </div>
</template>
