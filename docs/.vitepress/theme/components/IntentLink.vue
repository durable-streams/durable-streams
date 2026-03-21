<script setup>
import { computed } from "vue"

const props = defineProps(["intent", "serviceType", "serviceVariant"])

const href = computed(() => {
  const url = new URL(`https://dashboard.electric-sql.cloud`)
  url.searchParams.set(`intent`, props.intent)
  url.searchParams.set(`serviceType`, props.serviceType)

  if (props.serviceVariant) {
    url.searchParams.set(`serviceVariant`, props.serviceVariant)
  }

  return url.toString()
})
</script>

<template>
  <div class="cta">
    <VPButton :href="href" theme="brand" text="Deploy now ↗" target="_blank" />
  </div>
</template>

<style scoped>
.cta {
  margin: 24px 0 0 0;
}
.cta a {
  text-decoration: none;
}
</style>
