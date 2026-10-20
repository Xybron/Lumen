<script setup lang="ts">
import type { Component } from 'vue';
import { MoreHorizontal } from 'lucide-vue-next';
import { DropdownMenuRoot, DropdownMenuTrigger, DropdownMenuPortal, DropdownMenuContent, DropdownMenuItem } from 'reka-ui';

export interface LibraryAction {
  label: string;
  icon: Component;
  href?: string;
  run?: () => void;
  disabled?: boolean;
}
defineProps<{ label: string; actions: LibraryAction[] }>();
</script>

<template>
  <DropdownMenuRoot>
    <DropdownMenuTrigger class="clip-icon-button library-more" :aria-label="label"><MoreHorizontal :size="17" /></DropdownMenuTrigger>
    <DropdownMenuPortal>
      <DropdownMenuContent class="library-context-menu" align="end" :side-offset="6" :collision-padding="10">
        <template v-for="action in actions" :key="action.label">
          <DropdownMenuItem v-if="action.href" as-child :disabled="action.disabled" class="library-context-item">
            <a :href="action.href"><component :is="action.icon" :size="14" /><span>{{ action.label }}</span></a>
          </DropdownMenuItem>
          <DropdownMenuItem v-else :disabled="action.disabled" class="library-context-item" @select="action.run?.()"><component :is="action.icon" :size="14" /><span>{{ action.label }}</span></DropdownMenuItem>
        </template>
      </DropdownMenuContent>
    </DropdownMenuPortal>
  </DropdownMenuRoot>
</template>
