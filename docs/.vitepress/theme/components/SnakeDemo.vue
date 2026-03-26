<script setup>
const { src } = defineProps({
  src: {
    type: String,
    default: "/y-snake/",
  },
})
</script>

<template>
  <div class="snake-demo">
    <iframe
      :src="src"
      allow="clipboard-write"
      sandbox="allow-same-origin allow-scripts allow-popups"
    />
  </div>
</template>

<style scoped>
.snake-demo {
  position: relative;
  width: 100%;
  height: 90vh;
  margin: 24px 0;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid var(--vp-c-divider);
}
.snake-demo iframe {
  width: 100%;
  height: 100%;
  border: none;
}
</style>
