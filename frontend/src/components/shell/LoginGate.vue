<script setup lang="ts">
import { ref } from 'vue';
import { Aperture, ArrowRight, Eye, EyeOff, ShieldCheck } from 'lucide-vue-next';
import { useIdentityStore } from '@/stores/identity';

const identity = useIdentityStore();

const username = ref('');
const password = ref('');
const error = ref('');
const busy = ref(false);
const revealPassword = ref(false);

async function submit() {
  if (busy.value) return;
  error.value = '';
  busy.value = true;
  try {
    await identity.login(username.value.trim(), password.value);
  } catch (e) {
    error.value = /401/.test((e as Error).message) ? 'Invalid username or password.' : 'Could not reach the station.';
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <main class="lumen-login">
    <div class="login-layout">
      <div class="login-brand"><Aperture :size="27" :stroke-width="1.5" /><span>lumen</span></div>
      <form class="login-form" :aria-busy="busy" @submit.prevent="submit">
        <div class="login-heading"><h1>Sign in to your station</h1><p>Your scenes, channels, and production tools.</p></div>
      <label class="login-field">
        <span>Username</span>
        <input
          v-model="username"
          type="text"
          name="username"
          autocomplete="username"
          autocapitalize="none"
          :spellcheck="false"
          :disabled="busy"
          :aria-describedby="error ? 'login-error' : undefined"
          required
          autofocus
        />
      </label>
      <div class="login-field">
        <label for="station-password">Password</label>
        <div class="login-password">
        <input
          id="station-password"
          v-model="password"
          :type="revealPassword ? 'text' : 'password'"
          name="password"
          autocomplete="current-password"
          :disabled="busy"
          :aria-describedby="error ? 'login-error' : undefined"
          required
        />
        <button type="button" :aria-label="revealPassword ? 'Hide password' : 'Show password'" :aria-pressed="revealPassword" :disabled="busy" @click="revealPassword = !revealPassword"><EyeOff v-if="revealPassword" :size="15" /><Eye v-else :size="15" /></button>
        </div>
      </div>
      <p v-if="error" id="login-error" class="login-error" role="alert">{{ error }}</p>
      <button
        type="submit"
        :disabled="busy || !username.trim() || !password"
        class="login-submit"
      >
        {{ busy ? 'Signing in…' : 'Sign in' }}<ArrowRight v-if="!busy" :size="15" />
      </button>
      <details class="login-setup"><summary>First time setting up Lumen?</summary><p>A new station starts with <code>admin</code> / <code>admin</code>. Change this password in Team &amp; roles after signing in. Existing stations use your assigned account.</p></details>
      </form>
      <p class="login-note"><ShieldCheck :size="13" />Operator access · Public outputs stay separate</p>
    </div>
  </main>
</template>

<style scoped>
.lumen-login { height: 100dvh; min-height: 0; display: grid; place-items: safe center; padding: 32px 20px; background: var(--bg-base); color: var(--text-primary); overflow: auto; }
.login-layout { width: min(380px, 100%); }
.login-brand { display: flex; align-items: center; gap: 9px; margin-bottom: 28px; font-size: 27px; font-weight: 550; letter-spacing: -1.2px; }
.login-brand svg { color: var(--accent); }
.login-form { display: flex; flex-direction: column; gap: 19px; padding: 28px; border-radius: var(--radius-panel); border: 1px solid var(--border-hair); background: var(--surface-1); }
.login-heading { margin-bottom: 3px; }
.login-heading h1 { font-size: 20px; font-weight: 550; letter-spacing: -.55px; line-height: 1.4; }
.login-heading p { color: var(--text-muted); font-size: 12px; line-height: 1.6; margin-top: 5px; }
.login-field { display: flex; flex-direction: column; gap: 8px; color: #ced0d5; font-size: 12px; }
.login-field input { width: 100%; min-width: 0; height: 40px; padding: 0 11px; border: 1px solid var(--border-glow); border-radius: var(--radius-control); background: var(--bg-base); color: var(--text-primary); font-size: 13px; outline: none; transition: border-color 120ms; }
.login-field input:focus { border-color: #7dd3fc77; }
.login-password { position: relative; }
.login-password input { padding-right: 42px; }
.login-password button { position: absolute; right: 4px; top: 4px; display: grid; place-items: center; height: 32px; width: 32px; border-radius: 5px; color: var(--text-muted); }
.login-password button:hover { color: var(--text-primary); background: var(--bg-hover); }
.login-submit { display: flex; align-items: center; justify-content: center; gap: 10px; height: 40px; border-radius: var(--radius-control); color: #102532; background: var(--accent); font-size: 12px; font-weight: 600; transition: background-color 120ms; }
.login-submit:hover:not(:disabled) { background: #a4e2ff; }
.login-submit:disabled { opacity: .4; cursor: not-allowed; }
.login-error { color: #efa6a0; font-size: 12px; line-height: 1.6; margin-top: -4px; }
.login-setup { border-top: 1px solid var(--border-hair); padding-top: 16px; margin-top: 1px; font-size: 11px; color: var(--text-muted); }
.login-setup summary { cursor: pointer; }
.login-setup p { line-height: 1.7; margin-top: 10px; }
.login-setup code { color: var(--text-primary); }
.login-note { display: flex; align-items: center; justify-content: center; gap: 7px; padding-top: 19px; color: var(--text-subtle); font-size: 10px; }
@media (max-width: 420px) { .login-form { padding: 24px 20px; } }
</style>
