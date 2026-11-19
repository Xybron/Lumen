<script lang="ts" setup>
import type { ToasterProps } from 'vue-sonner'

import { reactiveOmit } from '@vueuse/core'
import {
  CircleCheckIcon,
  InfoIcon,
  OctagonXIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-vue-next'
import { Toaster as Sonner } from 'vue-sonner'
import { SkeletonIndicator } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'

const props = defineProps<ToasterProps>()
const forwarded = reactiveOmit(props, 'toastOptions', 'class')
</script>

<template>
  <Sonner
    :class="cn('toaster group', props.class)"
    :style="{
      '--normal-bg': 'var(--popover)',
      '--normal-text': 'var(--popover-foreground)',
      '--normal-border': 'var(--border)',
      '--border-radius': 'var(--radius)',
    }"
    :toast-options="{
      classes: {
        toast: 'rounded-2xl',
      },
      ...(props.toastOptions ?? {}),
    }"
    v-bind="forwarded"
  >
    <template #success-icon>
      <CircleCheckIcon class="size-4" />
    </template>
    <template #info-icon>
      <InfoIcon class="size-4" />
    </template>
    <template #warning-icon>
      <TriangleAlertIcon class="size-4" />
    </template>
    <template #error-icon>
      <OctagonXIcon class="size-4" />
    </template>
    <template #loading-icon>
      <div>
        <SkeletonIndicator />
      </div>
    </template>
    <template #close-icon>
      <XIcon class="size-4" />
    </template>
  </Sonner>
</template>
